import { expect, test } from 'vitest';
import { audioInput, audioOutput, CAPACITY_16, compile, decodeSnapshot, defineProcessor, encodeScalar, encodeSnapshot, event, f32, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { residentSample } from '../src/sample.js';
import { wavetableSource } from '../src/wavetable.js';
import { bin, tableReference } from './fixtures/wavetable-reference.js';
const rates = [44100, 48000, 96000], duration = (n: number, rate: number) => (n - .25) / rate;
function close(actual: Float32Array, expected: Float32Array, tolerance = 2e-6) {
  expect(actual.length).toBe(expected.length); let error = 0;
  actual.forEach((x, n) => { expect(Number.isFinite(x)).toBe(true); error = Math.max(error, Math.abs(x - expected[n])); });
  expect(error).toBeLessThan(tolerance);
}
function processor(rate: number, frameLength: number, frameCount: number, phaseCycles = 0, capacity = frameLength * frameCount) {
  return defineProcessor(() => {
    const sample = instantiate(residentSample, { capacity, sourceSampleRate: 32000 }, { name: 'asset' });
    const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: capacity * 4 });
    load.onReceive(({ data }) => sample.load(data));
    const source = instantiate(wavetableSource, { sampleRate: rate, sample, frameLength, frameCount, phaseCycles }, { name: 'source' });
    const input = audioInput({ channels: 3, name: 'controls' }), output = audioOutput({ channels: 2, name: 'main' });
    return { process() { forSample(i => {
      const result = source.tick({ frequencyHz: input.ch(0).at(i), frame: input.ch(1).at(i), reset: input.ch(2).at(i).gt(0) });
      output.ch(0).at(i).write(result.output); output.ch(1).at(i).write(f32(result.missing));
    }); } };
  });
}
const constant = (n: number, frequency: number, frame = 0) => [new Float32Array(n).fill(frequency), new Float32Array(n).fill(frame), new Float32Array(n)];
for (const rate of rates) {
  test(`wavetable independent periodic PCM/morph oracle, boundaries/reset/hold/snapshot ${rate}`, async () => {
    const n = 1024, length = 17, count = 3, data = Float32Array.from({ length: length * count }, (_, i) => (1 + Math.floor(i / length)) * Math.sin(2 * Math.PI * (i % length) / length) / 3);
    const controls = [Float32Array.from({ length: n }, (_, i) => i < 128 ? 0 : i < 256 ? -100 : i < 384 ? Infinity : i < 512 ? NaN : 1000 + i),
      Float32Array.from({ length: n }, (_, i) => [-Infinity, 0, .25, 1.5, 2, Infinity, NaN][Math.floor(i / 128)] ?? .75),
      Float32Array.from({ length: n }, (_, i) => +(i >= 500 && i < 510 || i === 900))];
    const p = processor(rate, length, count, .975), full = await renderOffline(p, { sampleRate: rate, duration: duration(n, rate), inputs: { controls }, messages: [{ name: 'load', payload: { data } }] });
    close(full.outputs.main[0], tableReference(data, rate, length, count, controls, .975)); expect(full.diagnostics.scrubbedSamples).toBe(0);
    expect(full.outputs.main[1]).toEqual(new Float32Array(n));
    const first = await renderOffline(p, { sampleRate: rate, duration: duration(512, rate), inputs: { controls: controls.map(x => x.slice(0, 512)) }, messages: [{ name: 'load', payload: { data } }] });
    const rest = await renderOffline(p, { sampleRate: rate, duration: duration(512, rate), inputs: { controls: controls.map(x => x.slice(512)) }, restore: first.state });
    expect(rest.outputs.main).toEqual(full.outputs.main.map(x => x.slice(512)));
  });
  test(`wavetable length4/frame1, fractional wrap never crosses adjacent morph frame ${rate}`, async () => {
    const controls = constant(128, 0, .5), data = Float32Array.of(1, 2, 3, 4, 10, 20, 30, 40);
    for (const count of [1, 2]) {
      const r = await renderOffline(processor(rate, 4, count, .875, 8), { sampleRate: rate, duration: duration(128, rate), inputs: { controls }, messages: [{ name: 'load', payload: { data } }] });
      expect(r.outputs.main[0]).toEqual(new Float32Array(128).fill(count === 1 ? 2.5 : 13.75)); expect(r.diagnostics.scrubbedSamples).toBe(0);
    }
  });
  test(`wavetable missing, short/empty replacement and same-length revision restart ${rate}`, async () => {
    const p = processor(rate, 4, 2, .25), controls = constant(768, rate / 13, .5), data = Float32Array.of(1, 2, 3, 4, 10, 20, 30, 40);
    const r = await renderOffline(p, { sampleRate: rate, duration: duration(768, rate), inputs: { controls }, messages: [
      { name: 'load', payload: { data }, atQuantum: 1 }, { name: 'load', payload: { data: data.slice(0, 7) }, atQuantum: 2 },
      { name: 'load', payload: { data }, atQuantum: 3 }, { name: 'load', payload: { data }, atQuantum: 4 }, { name: 'load', payload: { data: new Float32Array() }, atQuantum: 5 },
    ] });
    for (const block of [0, 2, 5]) { expect(r.outputs.main[0].slice(block * 128, (block + 1) * 128)).toEqual(new Float32Array(128)); expect(r.outputs.main[1][block * 128]).toBe(1); }
    for (const block of [1, 3, 4]) { expect(r.outputs.main[0][block * 128]).toBe(11); expect(r.outputs.main[1][block * 128]).toBe(0); }
    expect(r.outputs.main[0].slice(128, 256)).toEqual(r.outputs.main[0].slice(384, 512)); expect(r.diagnostics.scrubbedSamples).toBe(0);
  });
  test(`wavetable independent sine frequency and explicit high-harmonic alias ${rate}`, async () => {
    const length = 64, n = 4096, data = Float32Array.from({ length }, (_, i) => Math.sin(2 * Math.PI * i / length));
    const r = await renderOffline(processor(rate, length, 1), { sampleRate: rate, duration: duration(n, rate), inputs: { controls: constant(n, rate / 64) }, messages: [{ name: 'load', payload: { data } }] });
    expect(bin(r.outputs.main[0], 64).magnitude).toBeCloseTo(1, 6); expect(bin(r.outputs.main[0], 63).magnitude).toBeLessThan(1e-6);
    const high = Float32Array.from({ length }, (_, i) => Math.sin(2 * Math.PI * 20 * i / length));
    const alias = await renderOffline(processor(rate, length, 1), { sampleRate: rate, duration: duration(n, rate), inputs: { controls: constant(n, rate / 32) }, messages: [{ name: 'load', payload: { data: high } }] });
    expect(bin(alias.outputs.main[0], 1536).im).toBeCloseTo(.5, 6); expect(alias.diagnostics.scrubbedSamples).toBe(0);
  });
}
test('wavetable resident revision wrap restarts on replacement', async () => {
  const rate = 48000, p = processor(rate, 4, 1), data = Float32Array.of(1, 2, 3, 4), controls = constant(128, 1234);
  const first = await renderOffline(p, { sampleRate: rate, duration: duration(128, rate), inputs: { controls }, messages: [{ name: 'load', payload: { data } }] });
  for (const before of [2147483647, -1]) {
    const snapshot = decodeSnapshot(first.state), revisions = snapshot.slots.filter(s => s.name === 'asset/revision' || s.name === 'source/revision');
    expect(revisions.length).toBe(2); revisions.forEach(s => { s.data = encodeScalar('i32', before); });
    const restore = encodeSnapshot(snapshot.schemaHash, snapshot.profile, snapshot.slots, snapshot.processorId);
    const r = await renderOffline(p, { sampleRate: rate, duration: duration(128, rate), inputs: { controls }, restore, messages: [{ name: 'load', payload: { data: Float32Array.of(10, 20, 30, 40) } }] });
    expect(r.outputs.main[0][0]).toBe(10); expect(r.diagnostics.scrubbedSamples).toBe(0);
  }
});
test('wavetable nonfinite taps, full finite range and subnormal PCM remain bounded', async () => {
  const rate = 48000;
  for (const data of [Float32Array.of(NaN, Infinity, -Infinity, 1, 0, 1, -1, .5), Float32Array.of(3.4028234663852886e38, -3.4028234663852886e38, 1, -1, -3.4028234663852886e38, 3.4028234663852886e38, -1, 1), Float32Array.of(1e-40, -1e-40, 1e-38, -1e-38, -1e-40, 1e-40, -1e-38, 1e-38)]) {
    const controls = constant(512, 1357, .4), r = await renderOffline(processor(rate, 4, 2), { sampleRate: rate, duration: duration(512, rate), inputs: { controls }, messages: [{ name: 'load', payload: { data } }] });
    const expected = tableReference(data, rate, 4, 2, controls); let relative = 0;
    r.outputs.main[0].forEach((x, n) => { expect(Number.isFinite(x)).toBe(true); relative = Math.max(relative, Math.abs(x - expected[n]) / Math.max(1e-37, Math.abs(expected[n]))); });
    expect(relative).toBeLessThan(1e-5); expect(r.diagnostics.scrubbedSamples).toBe(0);
  }
});
test('maximum resident/frame count has fixed memory, bounded compile and exact last-frame wrap', async () => {
  const p = processor(48000, 4096, 16, 1 - .5 / 4096), data = new Float32Array(65536); data[61440] = -1; data[65535] = .5;
  const controls = constant(128, 0, 15), r = await renderOffline(p, { sampleRate: 48000, duration: duration(128, 48000), inputs: { controls }, messages: [{ name: 'load', payload: { data } }] });
  expect(r.outputs.main[0]).toEqual(new Float32Array(128).fill(-.25));
  const restored = await renderOffline(p, { sampleRate: 48000, duration: duration(128, 48000), inputs: { controls }, restore: r.state });
  expect(restored.outputs.main).toEqual(r.outputs.main);
  const compiled = await compile(p, { sampleRate: 48000 }), driver = await compiled.driver.instantiate(), bytes = driver.memory.buffer.byteLength;
  for (let n = 0; n < 32; n++) driver.process();
  expect(driver.memory.buffer.byteLength).toBe(bytes); expect(bytes).toBeLessThan(5 * 1024 * 1024); expect(compiled.wasm.byteLength).toBeLessThan(100 * 1024); expect(driver.scrubbedSamples()).toBe(0);
});
test('smallest positive f32 Hz accumulates; tiny frame morph survives full finite PCM', async () => {
  const rate = 96000, n = 256, frequency = Math.fround(2 ** -149), data = Float32Array.of(0, 3e38, 0, 0, 3e38, 3e38, 3e38, 3e38);
  for (const frame of [0, Math.fround(1e-40)]) {
    const controls = constant(n, frequency, frame), r = await renderOffline(processor(rate, 4, 2), { sampleRate: rate, duration: duration(n, rate), inputs: { controls }, messages: [{ name: 'load', payload: { data } }] });
    close(r.outputs.main[0], tableReference(data, rate, 4, 2, controls), 1e-8);
    expect(r.outputs.main[0][255]).toBeGreaterThan(r.outputs.main[0][0]); expect(r.diagnostics.scrubbedSamples).toBe(0);
  }
});
test('morph15 of sixteen frames preserves full finite PCM and exact snapshot', async () => {
  const rate = 48000, data = Float32Array.from({ length: 64 }, (_, i) => i < 60 ? 1 : 3.4028234663852886e38);
  const p = processor(rate, 4, 16, .125), controls = constant(128, rate * .45, 15);
  const r = await renderOffline(p, { sampleRate: rate, duration: duration(128, rate), inputs: { controls }, messages: [{ name: 'load', payload: { data } }] });
  expect(r.outputs.main[0]).toEqual(new Float32Array(128).fill(data[63])); expect(r.diagnostics.scrubbedSamples).toBe(0);
  const restored = await renderOffline(p, { sampleRate: rate, duration: duration(128, rate), inputs: { controls }, restore: r.state });
  expect(restored.outputs.main).toEqual(r.outputs.main); expect(restored.diagnostics.scrubbedSamples).toBe(0);
  for (const snapshot of [r.state, restored.state]) for (const s of decodeSnapshot(snapshot).slots.filter(s => s.name.includes('scaled'))) {
    const bytes = s.data; expect(Number.isFinite(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true))).toBe(true);
  }
});
test('wavetable f64 Number.MIN_VALUE initial phase survives zero-Hz state and restore', async () => {
  const rate = 48000, p = processor(rate, 4, 1, Number.MIN_VALUE), controls = constant(128, 0);
  const first = await renderOffline(p, { sampleRate: rate, duration: duration(128, rate), inputs: { controls }, messages: [{ name: 'load', payload: { data: Float32Array.of(0, 1, 0, -1) } }] });
  const rest = await renderOffline(p, { sampleRate: rate, duration: duration(128, rate), inputs: { controls }, restore: first.state });
  for (const state of [first.state, rest.state]) {
    const s = decodeSnapshot(state).slots.find(s => s.name === 'source/scaledPhase')!, bytes = s.data;
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true) / 2 ** 1020).toBe(Number.MIN_VALUE);
  }
  expect(rest.outputs.main).toEqual(first.outputs.main); expect(rest.diagnostics.scrubbedSamples).toBe(0);
});
test('wavetable rejects invalid capacities, frame layouts, rates and phase', () => {
  for (const config of [{ frameLength: 3 }, { frameLength: 4097 }, { frameLength: 4.5 }, { frameCount: 0 }, { frameCount: 17 }, { frameLength: 4096, frameCount: 16 }, { phaseCycles: -1 }, { phaseCycles: 1 }, { phaseCycles: NaN }, { sampleRate: 7999 }, { sampleRate: 192001 }, { sampleRate: NaN }]) {
    expect(() => defineProcessor(() => { const sample = instantiate(residentSample, { capacity: 64, sourceSampleRate: 48000 }, { name: 'sample' }); instantiate(wavetableSource, { sampleRate: 48000, sample, frameLength: 4, frameCount: 1, ...config }); return { process() {} }; })).toThrow(RangeError);
  }
});
