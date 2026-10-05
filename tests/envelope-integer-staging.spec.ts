import { test, expect } from 'vitest';
import { audioInput, audioOutput, compile, defineProcessor, forSample, instantiate, select, state, type Node } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { envelope } from '../src/envelope.js';
import { envelope as baseline } from './fixtures/envelope-before-integer-staging.js';

// Differential comparisons use a frozen pre-change implementation; they are not
// independent numerical oracles. The closed-form test below is independent.
const rates = [44100, 48000, 96000];
type Row = [number, number, number, number, number, number, number];
const fixture = (env: typeof envelope, rate: number, aliases = false) => defineProcessor(() => {
  const input = audioInput({ channels: 7, name: 'controls' });
  const output = audioOutput({ channels: aliases ? 6 : 4, name: 'main' });
  const external = state.f32(0).named('external');
  const a = instantiate(env, { sampleRate: rate }, { name: 'a' });
  const b = instantiate(env, { sampleRate: rate }, { name: 'b' });
  return { process() { forSample(i => {
    external.write(input.ch(0).at(i));
    const gate = external.read().gt(0);
    const c = { gate, retrigger: input.ch(1).at(i).gt(0), reset: input.ch(2).at(i).gt(0),
      attack: input.ch(3).at(i), decay: input.ch(4).at(i), sustain: input.ch(5).at(i), release: input.ch(6).at(i) };
    const x = a.tick(c);
    external.write(-1); // A caller mutation must not change captured controls.
    const y = b.tick({ ...c, gate: gate.not(), retrigger: c.retrigger.and(false) });
    // Adversarial capture-order probe, not a new multi-tick-per-sample contract.
    const z = aliases ? a.tick({ ...c, gate: x.done.not(), sustain: x.level }) : null;
    const emit = (ch: number, value: { level: Node<'f32'>; done: Node<'bool'> }) => {
      output.ch(ch).at(i).write(value.level);
      output.ch(ch + 1).at(i).write(select(value.done, 1, 0));
    };
    emit(0, x); emit(2, y); if (z) emit(4, z);
  }); } };
});
const render = (processor: ReturnType<typeof fixture>, rate: number, rows: Row[], restore?: Uint8Array) =>
  renderOffline(processor, { sampleRate: rate, duration: (rows.length - 0.25) / rate,
    inputs: { controls: Array.from({ length: 7 }, (_, ch) => Float32Array.from(rows, r => r[ch])) }, restore });
const equal = (a: Awaited<ReturnType<typeof render>>, b: Awaited<ReturnType<typeof render>>) => {
  expect(a.outputs.main).toEqual(b.outputs.main);
  expect(a.state).toEqual(b.state);
  expect(a.diagnostics.scrubbedSamples).toBe(0);
  expect(b.diagnostics.scrubbedSamples).toBe(0);
};
for (const rate of rates) {
  test(`integer staging: independent ADSR endpoints and cold-restore negative at ${rate}`, async () => {
    const rows: Row[] = Array.from({ length: 640 }, (_, i) => [i < 400 ? 1 : 0, 0, 0, 64 / rate, 128 / rate, 0.25, 64 / rate]);
    const p = fixture(envelope, rate), whole = await render(p, rate, rows);
    for (let i = 0; i < 640; i++) {
      const expected = i < 64 ? (i + 1) / 64 : i < 192 ? 1 - 0.75 * (i - 63) / 128 : i < 400 ? 0.25 : i < 464 ? 0.25 * (463 - i) / 64 : 0;
      expect(whole.outputs.main[0][i]).toBeCloseTo(expected, 6);
      expect(whole.outputs.main[1][i]).toBe(i >= 463 ? 1 : 0);
    }
    const first = await render(p, rate, rows.slice(0, 128));
    const restored = await render(p, rate, rows.slice(128), first.state);
    const cold = await render(p, rate, rows.slice(128));
    expect(restored.outputs.main[0]).toEqual(whole.outputs.main[0].slice(128));
    expect(cold.outputs.main[0]).not.toEqual(restored.outputs.main[0]);
  });
  test(`integer staging: frozen baseline, full state and bidirectional restore at ${rate}`, async () => {
    const p = fixture(envelope, rate), old = fixture(baseline, rate);
    const [compiled, prior] = await Promise.all([compile(p, { sampleRate: rate }), compile(old, { sampleRate: rate })]);
    expect(compiled.schemaHash).toBe(prior.schemaHash);
    for (const kind of ['transitions', 'tiny', 'extreme'] as const) {
      const rows: Row[] = Array.from({ length: 768 }, (_, i) => [i < 384 || i >= 640 ? 1 : 0,
        [96, 255, 400, 700].includes(i) ? 1 : 0, [257, 513].includes(i) ? 1 : 0,
        kind === 'extreme' ? (i < 128 ? -1e30 : 1e30) : kind === 'tiny' ? 0.49 / rate : (i % 193) / rate,
        kind === 'extreme' ? 30 : kind === 'tiny' ? 0 : (i % 127) / rate,
        kind === 'tiny' ? (i % 2 ? 1e-35 : 2 ** -149) : kind === 'extreme' ? (i < 512 ? -1e30 : 1e30) : (i % 101) / 100,
        kind === 'extreme' ? 30 : kind === 'tiny' ? 0.51 / rate : (i % 67) / rate]);
      const a = await render(old, rate, rows), b = await render(p, rate, rows); equal(a, b);
      for (const split of [128, 256, 384, 512, 640]) {
        const x = await render(old, rate, rows.slice(0, split)), y = await render(p, rate, rows.slice(0, split)); equal(x, y);
        const forward = await render(p, rate, rows.slice(split), x.state);
        const backward = await render(old, rate, rows.slice(split), y.state); equal(forward, backward);
        a.outputs.main.forEach((channel, ch) => expect(forward.outputs.main[ch]).toEqual(channel.slice(split)));
        expect(forward.state).toEqual(a.state);
      }
    }
  });
  test(`integer staging: external controls and delayed return aliases at ${rate}`, async () => {
    const rows: Row[] = Array.from({ length: 256 }, (_, i) => [i % 113 < 70 ? 1 : 0, i % 83 === 0 ? 1 : 0, i % 97 === 0 ? 1 : 0, 17 / rate, 23 / rate, i % 2 ? 0.3 : 1e-35, 31 / rate]);
    equal(await render(fixture(envelope, rate, true), rate, rows), await render(fixture(baseline, rate, true), rate, rows));
  });
}

test('integer staging preserves the maximum supported i32 frame count', async () => {
  const envelopeRate = 71582788; // 30 seconds = 2147483640, within the validated bound.
  const rows: Row[] = Array.from({ length: 256 }, () => [1, 0, 0, 30, 0, 1, 30]);
  // The envelope's construction rate exercises integer arithmetic; the driver
  // uses its ordinary 48 kHz clock. This is not a supported browser-rate claim.
  const actual = await render(fixture(envelope, envelopeRate), 48000, rows);
  equal(actual, await render(fixture(baseline, envelopeRate), 48000, rows));
  actual.outputs.main[0].forEach((value, i) => {
    expect(Math.abs(value - (i + 1) / 2147483640)).toBeLessThan(1e-14);
    expect(actual.outputs.main[1][i]).toBe(0);
  });
});
