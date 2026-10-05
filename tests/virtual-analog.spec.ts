import { expect, test } from 'vitest';
import { audioInput, audioOutput, bool, decodeSnapshot, defineProcessor, f32, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { seededNoise, virtualAnalogSource } from '../src/virtual-analog.js';
import { bin, foldedCoefficient, noiseReference, vaReference } from './fixtures/wavetable-reference.js';
const rates = [44100, 48000, 96000], duration = (n: number, rate: number) => (n - .25) / rate;
function close(actual: Float32Array, expected: Float32Array, tolerance = 2e-6) {
  expect(actual.length).toBe(expected.length); let error = 0;
  actual.forEach((x, n) => { expect(Number.isFinite(x)).toBe(true); error = Math.max(error, Math.abs(x - expected[n])); });
  expect(error).toBeLessThan(tolerance);
}
function processor(rate: number, waveform: 'pulse' | 'triangle', phaseCycles = 0) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 3, name: 'controls' }), output = audioOutput({ channels: 1, name: 'main' });
    const source = instantiate(virtualAnalogSource, { sampleRate: rate, waveform, phaseCycles }, { name: 'source' });
    return { process() { forSample(i => output.ch(0).at(i).write(source.tick({ frequencyHz: input.ch(0).at(i), duty: input.ch(1).at(i), reset: input.ch(2).at(i).gt(0) }))); } };
  });
}
for (const rate of rates) for (const waveform of ['pulse', 'triangle'] as const) {
  test(`${waveform} independent convolution oracle: extreme PWM/frequency/phase/reset/hold ${rate}`, async () => {
    const n = 1024, controls = [Float32Array.from({ length: n }, (_, i) => [0, -1, NaN, Infinity, -Infinity, rate * .45, 330, 1e-20][Math.floor(i / 128)]),
      Float32Array.from({ length: n }, (_, i) => [0, 1, .001, .999, .2, .5, NaN, Infinity, -Infinity][i % 9]),
      Float32Array.from({ length: n }, (_, i) => +(i >= 250 && i < 260 || i === 400))];
    const p = processor(rate, waveform, .125), full = await renderOffline(p, { sampleRate: rate, duration: duration(n, rate), inputs: { controls } });
    close(full.outputs.main[0], vaReference(waveform, rate, controls, .125));
    expect(Math.max(...full.outputs.main[0].map(Math.abs))).toBeLessThanOrEqual(1.000001); expect(full.diagnostics.scrubbedSamples).toBe(0);
    const first = await renderOffline(p, { sampleRate: rate, duration: duration(512, rate), inputs: { controls: controls.map(x => x.slice(0, 512)) } });
    const rest = await renderOffline(p, { sampleRate: rate, duration: duration(512, rate), inputs: { controls: controls.map(x => x.slice(512)) }, restore: first.state });
    expect(rest.outputs.main[0]).toEqual(full.outputs.main[0].slice(512));
  });
  test(`${waveform} independent Fourier transfer, harmonics, DC and residual alias ${rate}`, async () => {
    const n = 4096, fundamental = 512, duty = Math.fround(.37), controls = [new Float32Array(n).fill(rate / 8), new Float32Array(n).fill(duty), new Float32Array(n)];
    const full = await renderOffline(processor(rate, waveform), { sampleRate: rate, duration: duration(n, rate), inputs: { controls } });
    for (const target of [0, 512, 1024, 1536]) {
      const actual = bin(full.outputs.main[0], target), expected = foldedCoefficient(waveform, n, fundamental, target, duty, true);
      expect(actual.re).toBeCloseTo(expected.re, 6); expect(actual.im).toBeCloseTo(expected.im, 6);
    }
    // Fifth harmonic lies above Nyquist and folds onto third harmonic. Isolate
    // the signed residual by subtracting the below-Nyquist analytical term.
    const third = bin(full.outputs.main[0], 1536), below = foldedCoefficient(waveform, 1000000000, 1, 3, duty, false);
    const sinc = Math.sin(3 * Math.PI / 8) / (3 * Math.PI / 8);
    const residual = Math.hypot(third.re - below.re * sinc ** 2, third.im - below.im * sinc ** 2);
    expect(residual).toBeGreaterThan(waveform === 'pulse' ? .001 : .0001);
    expect(full.diagnostics.scrubbedSamples).toBe(0);
  });
}
test('phase-zero values and pulse endpoints, reset independent instances', async () => {
  const p = defineProcessor(() => {
    const output = audioOutput({ channels: 5, name: 'main' });
    const sources = ['pulse', 'pulse', 'pulse', 'triangle', 'triangle'].map((waveform, i) => instantiate(virtualAnalogSource, { sampleRate: 48000, waveform: waveform as 'pulse' | 'triangle' }, { name: `source${i}` }));
    return { process() { forSample(i => sources.forEach((source, ch) => output.ch(ch).at(i).write(source.tick({ frequencyHz: f32(ch === 4 ? 0 : 4800), duty: f32(ch === 0 ? 0 : ch === 1 ? 1 : .5), reset: bool(true) })))); } };
  });
  const r = await renderOffline(p, { sampleRate: 48000, duration: duration(128, 48000) });
  [-1, 1, 0, -1 + .4 / 3, -1].forEach((x, ch) => close(r.outputs.main[ch], new Float32Array(128).fill(x)));
});
for (const rate of rates) test(`noise exact BigInt oracle, seeds, held reset, statistics and snapshot ${rate}`, async () => {
  const n = 16384, seeds = [1, 12345, 2147483646], resets = Float32Array.from({ length: n }, (_, i) => +(i === 1024 || i >= 2048 && i < 2052));
  const p = defineProcessor(() => {
    const input = audioInput({ channels: 1, name: 'reset' }), output = audioOutput({ channels: 3, name: 'main' });
    const sources = seeds.map((seed, i) => instantiate(seededNoise, { seed }, { name: `noise${i}` }));
    return { process() { forSample(i => sources.forEach((s, ch) => output.ch(ch).at(i).write(s.tick(input.ch(0).at(i).gt(0))))); } };
  });
  const full = await renderOffline(p, { sampleRate: rate, duration: duration(n, rate), inputs: { reset: [resets] } });
  for (const [ch, seed] of seeds.entries()) {
    close(full.outputs.main[ch], noiseReference(seed, resets), 1e-7);
    const data = full.outputs.main[ch].slice(4096), mean = data.reduce((a, b) => a + b, 0) / data.length, power = data.reduce((a, b) => a + b * b, 0) / data.length;
    expect(Math.abs(mean)).toBeLessThan(.025); expect(power).toBeGreaterThan(.31); expect(power).toBeLessThan(.36);
  }
  const first = await renderOffline(p, { sampleRate: rate, duration: duration(8192, rate), inputs: { reset: [resets.slice(0, 8192)] } });
  const rest = await renderOffline(p, { sampleRate: rate, duration: duration(8192, rate), inputs: { reset: [resets.slice(8192)] }, restore: first.state });
  expect(rest.outputs.main).toEqual(full.outputs.main.map(x => x.slice(8192))); expect(full.diagnostics.scrubbedSamples).toBe(0);
});
test('VA/noise invalid construction metadata is rejected', () => {
  const capture = (make: () => unknown) => () => defineProcessor(() => { make(); return { process() {} }; });
  for (const sampleRate of [NaN, 7999, 192001]) expect(capture(() => instantiate(virtualAnalogSource, { sampleRate, waveform: 'pulse' }))).toThrow(RangeError);
  for (const phaseCycles of [-1, 1, NaN]) expect(capture(() => instantiate(virtualAnalogSource, { sampleRate: 48000, waveform: 'triangle', phaseCycles }))).toThrow(RangeError);
  expect(capture(() => instantiate(virtualAnalogSource, { sampleRate: 48000, waveform: 'other' as 'pulse' }))).toThrow(RangeError);
  for (const seed of [0, -1, 1.5, NaN, 2147483647]) expect(capture(() => instantiate(seededNoise, { seed }))).toThrow(RangeError);
});
test('VA accumulates the smallest positive f32 frequency without native scalar flushing', async () => {
  const rate = 96000, n = 128, frequency = Math.fround(2 ** -149), controls = [new Float32Array(n).fill(frequency), new Float32Array(n).fill(.5), new Float32Array(n)];
  const r = await renderOffline(processor(rate, 'triangle'), { sampleRate: rate, duration: duration(n, rate), inputs: { controls } });
  const slot = decodeSnapshot(r.state).slots.find(s => s.name === 'source/scaledPhase'); expect(slot).toBeDefined();
  const bytes = slot!.data, stored = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true);
  expect(stored / 2 ** 1020 / (n * frequency / rate)).toBeCloseTo(1, 12); expect(r.diagnostics.scrubbedSamples).toBe(0);
});
test('VA f64 Number.MIN_VALUE phase survives held zero frequency and exact restore', async () => {
  const rate = 48000, controls = [new Float32Array(128), new Float32Array(128).fill(.5), new Float32Array(128)], p = processor(rate, 'triangle', Number.MIN_VALUE);
  const first = await renderOffline(p, { sampleRate: rate, duration: duration(128, rate), inputs: { controls } });
  const rest = await renderOffline(p, { sampleRate: rate, duration: duration(128, rate), inputs: { controls }, restore: first.state });
  for (const state of [first.state, rest.state]) {
    const s = decodeSnapshot(state).slots.find(s => s.name === 'source/scaledPhase')!, bytes = s.data;
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(0, true) / 2 ** 1020).toBe(Number.MIN_VALUE);
  }
  expect(rest.outputs.main).toEqual(first.outputs.main); expect(rest.diagnostics.scrubbedSamples).toBe(0);
});
