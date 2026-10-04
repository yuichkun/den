import { test, expect } from 'vitest';
import { audioInput, audioOutput, compile, defineProcessor, forSample, instantiate, inspect, f32, bool } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { filter } from '../src/filter.js';
import { filter as previous } from './probes/filter-before-materialization.js';

function fixture(unit: typeof filter, sampleRate: number) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 5, name: 'main' });
    const output = audioOutput({ channels: 4, name: 'main' });
    const a = instantiate(unit, { sampleRate }, { name: 'a' });
    const b = instantiate(unit, { sampleRate }, { name: 'b' });
    const cascade = instantiate(unit, { sampleRate }, { name: 'cascade' });
    return { process() { forSample(i => {
      const cutoff = input.ch(1).at(i), q = input.ch(2).at(i), reset = input.ch(3).at(i).gt(0);
      const first = a.tick(input.ch(0).at(i), cutoff, q, reset);
      const separate = b.tick(input.ch(4).at(i), cutoff, q, reset);
      // Consume a's result after another instance has run, also in a same-sample cascade.
      const next = cascade.tick(first, cutoff, q, reset);
      output.ch(0).at(i).write(first);
      output.ch(1).at(i).write(separate);
      output.ch(2).at(i).write(next);
      output.ch(3).at(i).write(first.mul(1e35));
    }); } };
  }, { id: 'den.filter.materialization.compatibility' });
}
function bytes(values: Float32Array) { return new Uint8Array(values.buffer, values.byteOffset, values.byteLength); }
for (const sampleRate of [8000, 44100, 48000, 96000, 192000]) {
  test(`filter materialization preserves PCM, schema and bidirectional snapshots at ${sampleRate}`, async () => {
    const oldGraph = fixture(previous, sampleRate), nextGraph = fixture(filter, sampleRate);
    const oldCompiled = await compile(oldGraph, { sampleRate }), nextCompiled = await compile(nextGraph, { sampleRate });
    expect(nextCompiled.schemaHash).toBe(oldCompiled.schemaHash);
    expect(nextCompiled.wasm.length).toBeLessThan(oldCompiled.wasm.length / 2);
    const n = 4096;
    const levels = [1, 1e-20, 1e-28, 1e-29, 1e-30, 1e-31, 1e-38, 1e-44];
    for (const level of levels) {
      const signal = Float32Array.from({ length: n }, (_, i) => level * Math.sin(i * 0.41));
      const cutoff = Float32Array.from(signal, (_, i) => [-100, 20, 23, 1000, sampleRate * 0.45, 1e6][i % 6]);
      const resonance = Float32Array.from(signal, (_, i) => [-10, 0.5, Math.SQRT1_2, 10, 100][i % 5]);
      const reset = Float32Array.from(signal, (_, i) => [0, 127, 128, 129, 2047, 2048].includes(i) ? 1 : 0);
      const inputs = [signal, cutoff, resonance, reset, new Float32Array(n)];
      const options = { sampleRate, duration: n / sampleRate, inputs: { main: inputs } };
      const old = await renderOffline(oldGraph, options), next = await renderOffline(nextGraph, options);
      for (let ch = 0; ch < 4; ch++) expect(bytes(next.outputs.main[ch])).toEqual(bytes(old.outputs.main[ch]));
      expect(next.outputs.main[1].every(x => x === 0)).toBe(true);
      if (level === 1e-30) expect(next.outputs.main[3].some(x => Math.abs(x) > 1e-4)).toBe(true);
      expect(next.state).toEqual(old.state);
      expect(Object.keys(inspect(next.state).slots).sort()).toEqual(['a/band', 'a/low', 'b/band', 'b/low', 'cascade/band', 'cascade/low']);
      // Resume a real suffix after the last reset, not a new block starting at
      // sample zero: a reset there would hide a missing/ignored restoration.
      const split = 3072;
      expect(reset.slice(split).every(x => x === 0)).toBe(true);
      const prefix = { sampleRate, duration: split / sampleRate, inputs: { main: inputs.map(x => x.slice(0, split)) } };
      const suffix = { sampleRate, duration: (n - split) / sampleRate, inputs: { main: inputs.map(x => x.slice(split)) } };
      const oldPrefix = await renderOffline(oldGraph, prefix), nextPrefix = await renderOffline(nextGraph, prefix);
      expect(oldPrefix.outputs.main[0].length).toBe(split);
      expect(nextPrefix.state).toEqual(oldPrefix.state);
      const oldResume = await renderOffline(oldGraph, { ...suffix, restore: nextPrefix.state });
      const nextResume = await renderOffline(nextGraph, { ...suffix, restore: oldPrefix.state });
      const expectContinuation = (result: typeof nextResume) => {
        for (let ch = 0; ch < 4; ch++) expect(bytes(result.outputs.main[ch])).toEqual(bytes(old.outputs.main[ch].slice(split)));
        expect(result.state).toEqual(old.state);
      };
      expectContinuation(oldResume);
      expectContinuation(nextResume);
      if (level === 1) {
        // Tiny levels can legitimately flush all history. At normal level,
        // omitting restore must fail the very same continuation assertion.
        const ignoredRestore = await renderOffline(nextGraph, suffix);
        expect(() => expectContinuation(ignoredRestore)).toThrow();
        expect(bytes(ignoredRestore.outputs.main[0])).not.toEqual(bytes(old.outputs.main[0].slice(split)));
      }
    }
  }, 60000);
}

// Intermediate audio values below 1e-30 are observable before the existing
// integrator flush, especially when a caller applies a finite gain afterwards.
function amplified(unit: typeof filter, cutoff: number, q: number) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 1, name: 'main' });
    const output = audioOutput({ channels: 1, name: 'main' });
    const tone = instantiate(unit, { sampleRate: 48000 }, { name: 'tone' });
    return { process() { forSample(i => output.ch(0).at(i).write(
      tone.tick(input.ch(0).at(i), f32(cutoff), f32(q), bool(false)).mul(1e30),
    )); } };
  }, { id: 'den.filter.amplified.compatibility' });
}
test('tiny constant input remains observable through a finite post-filter gain', async () => {
  for (const level of [1e-30, 1e-28]) {
    const options = { sampleRate: 48000, duration: 128 / 48000, inputs: { main: [new Float32Array(128).fill(level)] } };
    const old = await renderOffline(amplified(previous, 1000, 0.707), options);
    const next = await renderOffline(amplified(filter, 1000, 0.707), options);
    expect(bytes(next.outputs.main[0])).toEqual(bytes(old.outputs.main[0]));
    expect(next.state).toEqual(old.state);
    expect(next.outputs.main[0][0]).toBeGreaterThan(0.003);
    expect(next.diagnostics.scrubbedSamples).toBe(0);
  }
});
test('long low-level resonant tail retains the exact existing flush boundary', async () => {
  const input = new Float32Array(262144); input[0] = 1e-16;
  const options = { sampleRate: 48000, duration: input.length / 48000, inputs: { main: [input] } };
  const old = await renderOffline(amplified(previous, 20, 10), options);
  const next = await renderOffline(amplified(filter, 20, 10), options);
  expect(bytes(next.outputs.main[0])).toEqual(bytes(old.outputs.main[0]));
  expect(next.state).toEqual(old.state);
  expect(next.diagnostics.scrubbedSamples).toBe(0);
  // Preserve the old flush behavior, including any tiny residual; do not
  // substitute a new tail cutoff or require an exact-zero end state.
}, 60000);
