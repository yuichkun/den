import { test, expect } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate, select } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { envelope } from '../src/envelope.js';

const rates = [44100, 48000, 96000];
const length = 256;
type Row = [number, number, number, number, number, number, number];
// Test controls: gate, retrigger, reset, attack, decay, sustain, release.
const run = async (sampleRate: number, rows: Row[]) => {
  const processor = defineProcessor(() => {
    const input = audioInput({ channels: 7, name: 'controls' });
    const output = audioOutput({ channels: 4, name: 'main' });
    const a = instantiate(envelope, { sampleRate }, { name: 'a' });
    const b = instantiate(envelope, { sampleRate }, { name: 'b' });
    return { process() { forSample(i => {
      const c = { gate: input.ch(0).at(i).gt(0), retrigger: input.ch(1).at(i).gt(0), reset: input.ch(2).at(i).gt(0),
        attack: input.ch(3).at(i), decay: input.ch(4).at(i), sustain: input.ch(5).at(i), release: input.ch(6).at(i) };
      const x = a.tick(c);
      const y = b.tick({ ...c, gate: c.gate.not(), retrigger: c.retrigger.and(false), reset: c.reset.and(false) });
      output.ch(0).at(i).write(x.level); output.ch(1).at(i).write(select(x.done, 1, 0));
      output.ch(2).at(i).write(y.level); output.ch(3).at(i).write(select(y.done, 1, 0));
    }); } };
  });
  return (await renderOffline(processor, { sampleRate, duration: length / sampleRate,
    inputs: { controls: Array.from({ length: 7 }, (_, ch) => Float32Array.from(rows, row => row[ch])) } })).outputs.main;
};
const close = (actual: Float32Array, expected: number[]) => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => { expect(Number.isFinite(v)).toBe(true); expect(Math.abs(v - expected[i]), `sample ${i}: ${v} vs ${expected[i]}`).toBeLessThan(3e-6); });
};

for (const sampleRate of rates) {
  test(`linear ADSR endpoints and exact voice completion at ${sampleRate}`, async () => {
    const rows = Array.from({ length }, (_, n): Row => [n < 96 ? 1 : 0, 0, 0, 16 / sampleRate, 32 / sampleRate, 0.25, 16 / sampleRate]);
    const [actual, done, other, otherDone] = await run(sampleRate, rows);
    const expected = rows.map((_, n) => n < 16 ? (n + 1) / 16 : n < 48 ? 1 - 0.75 * (n - 15) / 32 : n < 96 ? 0.25 : n < 112 ? 0.25 * (111 - n) / 16 : 0);
    close(actual, expected);
    close(done, rows.map((_, n) => n >= 111 ? 1 : 0));
    close(other, rows.map((_, n) => n < 96 ? 0 : n < 112 ? (n - 95) / 16 : n < 144 ? 1 - 0.75 * (n - 111) / 32 : 0.25));
    close(otherDone, rows.map((_, n) => n < 96 ? 1 : 0));
    expect(() => close(actual, expected.map(x => x * 0.9))).toThrow();
  });

  test(`retrigger during attack/release, note-off from current value, reset at ${sampleRate}`, async () => {
    const rows = Array.from({ length }, (_, n): Row => [n < 8 || (n >= 12 && n < 40) ? 1 : 0, n === 4 ? 1 : 0, n === 20 ? 1 : 0, 8 / sampleRate, 8 / sampleRate, 0.5, 8 / sampleRate]);
    const [actual, done] = await run(sampleRate, rows);
    // Closed-form piecewise ramps from independently calculated event values.
    close(actual, rows.map((_, n) => n < 4 ? (n + 1) / 8 : n < 8 ? 0.5 + 0.5 * (n - 3) / 8 : n < 12 ? 0.75 * (15 - n) / 8 : n < 20 ? 0.375 + 0.625 * (n - 11) / 8 : 0));
    close(done, rows.map((_, n) => n >= 20 ? 1 : 0));
  });

  test(`zero/tiny durations, zero sustain, reset priority, gate-off priority at ${sampleRate}`, async () => {
    const rows = Array.from({ length }, (_, n): Row => [n < 40 || n >= 80 ? 1 : 0, n === 40 || n === 83 ? 1 : 0, n === 81 ? 1 : 0, 0.1 / sampleRate, 0, 0, 0]);
    const [actual, done] = await run(sampleRate, rows);
    close(actual, rows.map(() => 0));
    close(done, rows.map((_, n) => n < 40 || n === 80 || n >= 83 ? 0 : 1));
    rows.forEach(row => { row[5] = 0.75; });
    const [nonzero] = await run(sampleRate, rows);
    close(nonzero, rows.map((_, n) => n < 40 || n === 80 || n >= 83 ? 0.75 : 0));
  });

  test(`zero attack enters nonzero decay; segment settings latch at ${sampleRate}`, async () => {
    const rows = Array.from({ length }, (_, n): Row => [n < 24 ? 1 : 0, 0, 0, 0, n < 4 ? 8 / sampleRate : 30, n < 4 ? 0.5 : 0.25, n < 25 ? 8 / sampleRate : 0]);
    const [actual, done] = await run(sampleRate, rows);
    close(actual, rows.map((_, n) => n < 8 ? 1 - 0.5 * (n + 1) / 8 : n < 24 ? 0.25 : n < 32 ? 0.25 * (31 - n) / 8 : 0));
    close(done, rows.map((_, n) => n >= 31 ? 1 : 0));
  });

  test(`parameter bounds and held retrigger at ${sampleRate}`, async () => {
    const rows = Array.from({ length }, (_, n): Row => [1, 1, 0, -1, -1, n < 128 ? 2 : -2, -1]);
    const [actual, done] = await run(sampleRate, rows);
    close(actual, rows.map((_, n) => n < 128 ? 1 : 0)); close(done, rows.map(() => 0));
    rows.forEach(row => { row[1] = 0; row[3] = 60; });
    const [long] = await run(sampleRate, rows);
    close(long, rows.map((_, n) => (n + 1) / (30 * sampleRate)));
  });
}

test('30-second attack remains linear at the longest offline rate and restores identically', async () => {
  const sampleRate = 96000;
  const processor = defineProcessor(() => {
    const input = audioInput({ channels: 7, name: 'controls' });
    const output = audioOutput({ channels: 1, name: 'main' });
    const env = instantiate(envelope, { sampleRate }, { name: 'long' });
    return { process() { forSample(i => output.ch(0).at(i).write(env.tick({
      gate: input.ch(0).at(i).gt(-1), retrigger: input.ch(1).at(i).gt(1), reset: input.ch(2).at(i).gt(1),
      attack: input.ch(3).at(i).add(30), decay: input.ch(4).at(i), sustain: input.ch(5).at(i), release: input.ch(6).at(i),
    }).level)); } };
  });
  const size = 2 ** 22; // Full 30-second segment, integral render quanta.
  const result = await renderOffline(processor, { sampleRate, duration: size / sampleRate });
  expect(result.outputs.main[0].length).toBe(size);
  for (const n of [0, 127, 65535, 999999, 1439999, 2879998, 2879999]) {
    expect(Math.abs(result.outputs.main[0][n] - (n + 1) / 2880000)).toBeLessThan(1e-7);
  }
  // Zero decay takes the sustain value on the first sample after attack.
  expect(result.outputs.main[0][2880000]).toBe(0);
  const first = await renderOffline(processor, { sampleRate, duration: 128 / sampleRate });
  const continuation = await renderOffline(processor, { sampleRate, duration: 128 / sampleRate, restore: first.state });
  close(continuation.outputs.main[0], Array.from(result.outputs.main[0].slice(128, 256)));
}, 30000);

test('release from zero frees immediately; fractional durations round to nearest sample', async () => {
  const sampleRate = 48000;
  const rows = Array.from({ length }, (_, n): Row => [n < 32 ? 1 : 0, 0, 0, 3.25 / sampleRate, 2.75 / sampleRate, 0, 30]);
  const [actual, done] = await run(sampleRate, rows);
  close(actual, rows.map((_, n) => n < 3 ? (n + 1) / 3 : n < 6 ? (5 - n) / 3 : 0));
  close(done, rows.map((_, n) => n >= 32 ? 1 : 0));
});
