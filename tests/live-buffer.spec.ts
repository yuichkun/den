import { expect, test } from 'vitest';
import { audioInput, audioOutput, bool, compile, decodeScalar, decodeSnapshot, defineProcessor, encodeScalar, encodeSnapshot, f32, f64, forSample, instantiate, state } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { liveSampleBuffer } from '../src/live-buffer.js';
import { liveReference, type LiveRow } from './fixtures/live-buffer-reference.js';

const rates = [44100, 48000, 96000];
const duration = (frames: number, rate: number) => (frames - .25) / rate;
const inputs = (rows: readonly LiveRow[]) => ({ controls: [Float32Array.from(rows, r => r.input), Float32Array.from(rows, r => +r.record), Float32Array.from(rows, r => +r.reset), Float32Array.from(rows, r => r.age)] });
function makeProcessor(rate: number, capacity: number) {
  return defineProcessor(() => {
    const history = instantiate(liveSampleBuffer, { capacity, sampleRate: rate }, { name: 'history' });
    const input = audioInput({ channels: 4, name: 'controls' }), output = audioOutput({ channels: 9, name: 'main' });
    return { process() { forSample(i => {
      const age = f64(input.ch(3).at(i)), before = history.readAge(age), beforeLength = history.length();
      const status = history.tick({ input: input.ch(0).at(i), record: input.ch(1).at(i).gt(0), reset: input.ch(2).at(i).gt(0) });
      const after = history.readAge(age);
      [before.output, f32(before.available), f32(beforeLength), after.output, f32(after.available), f32(status.length), f32(status.written), f32(status.full), f32(history.revision())].forEach((value, ch) => output.ch(ch).at(i).write(value));
    }); } };
  });
}
function run(rate: number, capacity: number, rows: readonly LiveRow[], restore?: Uint8Array) {
  return renderOffline(makeProcessor(rate, capacity), { sampleRate: rate, duration: duration(rows.length, rate), inputs: inputs(rows), ...(restore ? { restore } : {}) });
}

for (const rate of rates) {
  for (const capacity of [1, 2, 17]) test(`live history all-sample chronological reference, every wrap/pause/reset/read phase ${rate}/${capacity}`, async () => {
    const ages = [0, .25, .5, 1, capacity - 1.25, capacity - 1, capacity - .75, capacity, -1, NaN, Infinity, -Infinity];
    const rows = Array.from({ length: 2048 }, (_, n) => ({ input: Math.fround(Math.sin(n * .137) * 3), record: !(n >= 640 && n < 896) && n % 19 !== 0, reset: n === 127 || n >= 1023 && n < 1027, age: Math.fround(n < 512 ? (n % (capacity + 1)) + (n % 2 ? .5 : 0) : ages[n % ages.length]) }));
    const result = await run(rate, capacity, rows);
    expect(result.outputs.main).toEqual(liveReference(capacity, rows).output);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  });
  test(`live history exact snapshot continuation while partial/full/paused/reset ${rate}`, async () => {
    const rows = Array.from({ length: 1024 }, (_, n) => ({ input: Math.fround(Math.cos(n * .097)), record: n < 256 || n >= 512, reset: n >= 511 && n < 516, age: Math.fround((n % 319) + (n % 3 ? .25 : 0)) }));
    const full = await run(rate, 193, rows);
    expect(full.outputs.main).toEqual(liveReference(193, rows).output);
    for (const split of [128, 256, 384, 512, 640]) {
      const first = await run(rate, 193, rows.slice(0, split));
      const rest = await run(rate, 193, rows.slice(split), first.state);
      expect(rest.outputs.main).toEqual(full.outputs.main.map(ch => ch.slice(split)));
      expect(rest.diagnostics.scrubbedSamples).toBe(0);
      const slots = decodeSnapshot(first.state).slots;
      expect(slots.find(x => x.name === 'history/readAge')).toBeUndefined();
      expect(slots.filter(x => x.kind === 'buffer').map(x => x.data.byteLength)).toEqual([8 * 194]);
    }
  });
}

test('live buffer fixed construction contract rejects invalid capacity/rate', () => {
  for (const capacity of [0, -1, 1.5, 65537, Infinity, NaN]) expect(() => makeProcessor(48000, capacity)).toThrow(RangeError);
  for (const rate of [NaN, Infinity, 7999, 192001]) expect(() => makeProcessor(rate, 8)).toThrow(RangeError);
  for (const rate of [8000, 192000]) expect(() => makeProcessor(rate, 1)).not.toThrow();
});

test('live buffer preserves full finite f32, native flush-boundary neighbors, and sanitized invalid input', async () => {
  const floor = Math.fround(1e-30), bits = new Uint32Array(Float32Array.of(floor).buffer)[0];
  const adjacent = (offset: number) => new Float32Array(Uint32Array.of(bits + offset).buffer)[0];
  const values = [0, -0, 2 ** -149, -(2 ** -149), 1e-35, -1e-35, adjacent(-1), -adjacent(-1), floor, -floor, adjacent(1), -adjacent(1), 3.4028234663852886e38, -3.4028234663852886e38, NaN, Infinity, -Infinity];
  for (const rate of rates) {
    const rows = Array.from({ length: 384 }, (_, n) => ({ input: Math.fround(values[n % values.length]), record: n < 256, reset: false, age: n < 256 ? 0 : (n % values.length) }));
    const result = await run(rate, values.length, rows);
    expect(result.outputs.main).toEqual(liveReference(values.length, rows).output);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
    const slots = decodeSnapshot(result.state).slots, buffer = slots.find(x => x.name === 'history/pcm')!.data;
    const stored = new Float64Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    expect(stored[values.length]).toBe(0);
    for (let n = 256 - values.length; n < 256; n++) {
      const value = Math.fround(values[n % values.length]);
      expect(stored[n % values.length] / 2 ** 128).toBe(Number.isFinite(value) && value !== 0 ? value : 0);
    }
  }
});

test('fractional age preserves tiny f64 contributions and full-range interpolation, including oldest boundary', async () => {
  const ages = [0, 2 ** -276, 2 ** -149, 1e-35, .25, .5, .9999999999999999, 1, 1.0000000000000002, NaN, Infinity, -Infinity, -(2 ** -149)];
  const max = 3.4028234663852886e38;
  const processor = defineProcessor(ctx => {
    const history = instantiate(liveSampleBuffer, { capacity: 2, sampleRate: ctx.sampleRate }, { name: 'history' });
    const input = audioInput({ channels: 1, name: 'main' }), out = audioOutput({ channels: ages.length * 2, name: 'main' });
    const count = state.i32(0).named('count');
    return { process() { forSample(i => {
      history.tick({ input: input.ch(0).at(i), record: count.read().lt(2), reset: bool(false) });
      count.write(count.read().add(1));
      ages.forEach((age, n) => { const r = history.readAge(f64(age)); out.ch(n * 2).at(i).write(r.output); out.ch(n * 2 + 1).at(i).write(f32(r.available)); });
    }); } };
  });
  for (const rate of rates) for (const newest of [0, -max]) {
    const input = new Float32Array(128); input[0] = max; input[1] = newest;
    const result = await renderOffline(processor, { sampleRate: rate, duration: duration(128, rate), inputs: { main: [input] } });
    ages.forEach((age, n) => {
      const available = Number.isFinite(age) && age >= 0 && age <= 1;
      const expected = available ? Math.fround(newest + (max - newest) * age) : 0;
      expect(result.outputs.main[n * 2].slice(1)).toEqual(new Float32Array(127).fill(expected));
      expect(result.outputs.main[n * 2 + 1].slice(1)).toEqual(new Float32Array(127).fill(+available));
    });
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
});

test('pause and held reset preserve stored history bytes; refill never exposes stale frames', async () => {
  const rows = Array.from({ length: 512 }, (_, n) => ({ input: n < 128 ? n + 1 : -7, record: n < 128 || n >= 384 && n < 387, reset: n >= 256 && n < 384, age: n % 17 }));
  const full = await run(48000, 17, rows);
  expect(full.outputs.main).toEqual(liveReference(17, rows).output);
  const before = await run(48000, 17, rows.slice(0, 128)), paused = await run(48000, 17, rows.slice(0, 256)), reset = await run(48000, 17, rows.slice(0, 384));
  const bytes = (state: Uint8Array) => decodeSnapshot(state).slots.find(x => x.name === 'history/pcm')!.data;
  expect(bytes(paused.state)).toEqual(bytes(before.state)); expect(bytes(reset.state)).toEqual(bytes(before.state));
  expect(full.outputs.main[3].slice(256, 384)).toEqual(new Float32Array(128));
  expect(decodeScalar('i32', decodeSnapshot(reset.state).slots.find(x => x.name === 'history/head')!.data)).toBe(0);
});

test('mutation revision wraps on writes and held resets, and stays still during pause', async () => {
  const rows = Array.from({ length: 128 }, (_, n) => ({ input: .5, record: n < 2, reset: n === 2 || n === 3, age: 0 }));
  const seed = await run(48000, 2, rows);
  for (const value of [2147483647, -1]) {
    const snapshot = decodeSnapshot(seed.state); snapshot.slots.find(x => x.name === 'history/revision')!.data = encodeScalar('i32', value);
    const restored = encodeSnapshot(snapshot.schemaHash, snapshot.profile, snapshot.slots, snapshot.processorId);
    const result = await run(48000, 2, rows, restored);
    expect(result.outputs.main[8]).toEqual(Float32Array.from(rows, (_, n) => (value + Math.min(n + 1, 4)) | 0));
    expect(decodeScalar('i32', decodeSnapshot(result.state).slots.find(x => x.name === 'history/revision')!.data)).toBe((value + 4) | 0);
  }
});

test('maximum 65,536-frame history fills and overwrites without growing native memory', async () => {
  const capacity = 65536, frames = capacity + 512, rate = 48000;
  const rows = Array.from({ length: frames }, (_, n) => ({ input: Math.fround((n % 257 - 128) / 128), record: true, reset: false, age: n % 2 ? capacity - 1 : 0 }));
  const processor = makeProcessor(rate, capacity), result = await run(rate, capacity, rows);
  expect(result.outputs.main).toEqual(liveReference(capacity, rows).output);
  expect(result.outputs.main[7][capacity - 1]).toBe(1);
  const slots = decodeSnapshot(result.state).slots;
  expect(slots.filter(x => x.kind === 'buffer').map(x => x.data.byteLength)).toEqual([8 * (capacity + 1)]);
  expect(decodeScalar('i32', slots.find(x => x.name === 'history/head')!.data)).toBe(512);
  const compiled = await compile(processor, { sampleRate: rate }), driver = await compiled.driver.instantiate(), bytes = driver.memory.buffer.byteLength;
  for (let n = 0; n < 32; n++) driver.process();
  expect(driver.memory.buffer.byteLength).toBe(bytes); expect(bytes).toBeLessThan(2 * 1024 * 1024);
  expect(driver.scrubbedSamples()).toBe(0); expect(result.diagnostics.scrubbedSamples).toBe(0);
});
