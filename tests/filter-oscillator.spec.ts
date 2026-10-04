import { test, expect, afterAll } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate, inspect, type Node } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { filter } from '../src/filter.js';
import { oscillator } from '../src/oscillator.js';

import { mkdirSync, writeFileSync } from 'node:fs';
const aliasMeasurements: object[] = [];
afterAll(() => { mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/filter-oscillator-alias.json', JSON.stringify(aliasMeasurements, null, 2)); });
const rates = [44100, 48000, 96000];
const fill = (n: number, value: number) => new Float32Array(n).fill(value);
function fixture(rate: number, wave?: 'sine' | 'saw') {
  return defineProcessor(() => {
    const input = audioInput({ channels: 4, name: 'main' });
    const output = audioOutput({ channels: 2, name: 'main' });
    const a = wave ? instantiate(oscillator, { sampleRate: rate, waveform: wave }, { name: 'a' }) : instantiate(filter, { sampleRate: rate }, { name: 'a' });
    const b = wave ? instantiate(oscillator, { sampleRate: rate, waveform: wave }, { name: 'b' }) : instantiate(filter, { sampleRate: rate }, { name: 'b' });
    return { process() { forSample(i => {
      const reset = input.ch(3).at(i).gt(0);
      const x = input.ch(0).at(i), cutoff = input.ch(1).at(i), q = input.ch(2).at(i);
      // Separate declarations above ensure distinct persistent slots.
      const tick = (unit: typeof a, signal: typeof x) => wave
        ? (unit as { tick(frequency: Node<'f32'>, reset: Node<'bool'>): Node<'f32'> }).tick(signal, reset)
        : (unit as { tick(input: Node<'f32'>, cutoff: Node<'f32'>, q: Node<'f32'>, reset: Node<'bool'>): Node<'f32'> }).tick(signal, cutoff, q, reset);
      output.ch(0).at(i).write(tick(a, x));
      output.ch(1).at(i).write(tick(b, x.mul(0)));
    }); } };
  });
}
async function render(rate: number, channels: Float32Array[], wave?: 'sine' | 'saw', restore?: Uint8Array) {
  const result = await renderOffline(fixture(rate, wave), { sampleRate: rate, duration: channels[0].length / rate, inputs: { main: channels }, ...(restore ? { restore } : {}) });
  expect(result.outputs.main[0].length).toBe(channels[0].length);
  return result;
}
function maxError(a: ArrayLike<number>, b: ArrayLike<number>) { let e = 0; for (let i = 0; i < a.length; i++) e = Math.max(e, Math.abs(a[i] - b[i])); return e; }
function peak(a: ArrayLike<number>) { let p = 0; for (let i = 0; i < a.length; i++) { expect(Number.isFinite(a[i])).toBe(true); p = Math.max(p, Math.abs(a[i])); } return p; }
// Independent direct-form biquad obtained from bilinear H(s)=1/(s²+s/Q+1).
function reference(input: Float32Array, rate: number, cutoff: number, q: number) {
  const w = 2 * Math.PI * cutoff / rate, alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
  const b0 = (1 - Math.cos(w)) / 2 / a0, b1 = 2 * b0;
  const a1 = -2 * Math.cos(w) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return Float64Array.from(input, x => { const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; });
}
for (const rate of rates) {
  test(`filter independent impulse reference and boundaries at ${rate}`, async () => {
    const n = 4096, input = fill(n, 0); input[0] = 1;
    for (const cutoff of [20, 1000, Math.min(20000, rate * 0.45)]) for (const q of [0.5, Math.SQRT1_2, 10]) {
      const result = await render(rate, [input, fill(n, cutoff), fill(n, q), fill(n, 0)]);
      const expected = reference(input, rate, Math.fround(cutoff), Math.fround(q));
      expect(maxError(result.outputs.main[0], expected)).toBeLessThan(2e-6);
      expect(peak(result.outputs.main[1])).toBe(0);
    }
  }, 60000);
  test(`filter reset, clamp, snapshot and per-sample modulation at ${rate}`, async () => {
    const n = 32768;
    const input = Float32Array.from({ length: n }, (_, i) => i < n / 2 ? Math.sin(2 * Math.PI * 173 * i / rate) : 0);
    const cutoff = Float32Array.from(input, (_, i) => i % 2 ? 20 : 1e6);
    const q = Float32Array.from(input, (_, i) => i % 127 ? 10 : -10);
    const reset = fill(n, 0); reset[n / 2] = 1;
    const result = await render(rate, [input, cutoff, q, reset]);
    expect(peak(result.outputs.main[0])).toBeLessThan(25);
    expect(peak(result.outputs.main[0].subarray(n / 2))).toBe(0);
    expect(peak(result.outputs.main[1])).toBe(0);
    const clipped = await render(rate, [input, cutoff.map(x => Math.min(Math.max(x, 20), Math.min(20000, rate * 0.45))), q.map(x => Math.min(Math.max(x, 0.5), 10)), reset]);
    expect(maxError(result.outputs.main[0], clipped.outputs.main[0])).toBe(0);
    const short = [fill(256, 0.2), fill(256, 800), fill(256, 3), fill(256, 0)];
    const first = await render(rate, short.map(x => x.slice(0, 128)));
    const next = await render(rate, short.map(x => x.slice(128)), undefined, first.state);
    const whole = await render(rate, short);
    expect(maxError(next.outputs.main[0], whole.outputs.main[0].slice(128))).toBe(0);
  }, 60000);
  for (const wave of ['sine', 'saw'] as const) test(`${wave} phase, pitch, reset, zero, bounds and isolation at ${rate}`, async () => {
    const n = 4096, freq = fill(n, 440), reset = fill(n, 0); reset[123] = 1;
    freq.fill(0, 512, 640); freq.fill(-440, 640, 768); freq.fill(rate, 1024);
    const result = await render(rate, [freq, fill(n, 0), fill(n, 0), reset], wave);
    expect(peak(result.outputs.main[0])).toBeLessThanOrEqual(1.000001);
    expect(maxError(result.outputs.main[1], fill(n, wave === 'sine' ? 0 : -1))).toBe(0);
    expect(result.outputs.main[0][123]).toBe(0);
    expect(peak(result.outputs.main[0].slice(513, 768).map(x => x - result.outputs.main[0][512]))).toBe(0);
    if (wave === 'sine') {
      let phase = 0;
      const expected = Float64Array.from(freq, (f, i) => { if (reset[i]) phase = 0; const y = Math.sin(2 * Math.PI * phase); phase = (phase + Math.min(Math.max(f, 0), 0.45 * rate) / rate) % 1; return y; });
      expect(maxError(result.outputs.main[0], expected)).toBeLessThan(2e-6);
    }
    const short = [fill(256, 55), fill(256, 0), fill(256, 0), fill(256, 0)];
    const first = await render(rate, short.map(x => x.slice(0, 128)), wave);
    const next = await render(rate, short.map(x => x.slice(128)), wave, first.state);
    const whole = await render(rate, short, wave);
    expect(maxError(next.outputs.main[0], whole.outputs.main[0].slice(128))).toBe(0);
    const slots = inspect(whole.state).slots;
    expect(Object.keys(slots).filter(x => x.includes('phase')).length).toBe(2);
  }, 60000);
}

// Orthogonal projection onto only harmonics below Nyquist. The residual is
// folded energy, independent of the BLEP implementation; no FFT helper required.
function spectralResidual(signal: Float32Array, bin: number) {
  const n = signal.length, residual = Float64Array.from(signal);
  for (let harmonic = 1; harmonic * bin < n / 2; harmonic++) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const angle = 2 * Math.PI * harmonic * bin * i / n; re += signal[i] * Math.cos(angle); im += signal[i] * Math.sin(angle); }
    re *= 2 / n; im *= 2 / n;
    for (let i = 0; i < n; i++) { const angle = 2 * Math.PI * harmonic * bin * i / n; residual[i] -= re * Math.cos(angle) + im * Math.sin(angle); }
  }
  return Math.sqrt(residual.reduce((sum, v) => sum + v * v, 0) / n);
}
for (const rate of rates) test(`saw alias comparison and independent harmonic amplitudes at ${rate}`, async () => {
  const n = 8192;
  for (const bin of [37, 997, 3501]) {
    const frequency = rate * bin / n;
    const actual = (await render(rate, [fill(n, frequency), fill(n, 0), fill(n, 0), fill(n, 0)], 'saw')).outputs.main[0];
    const naive = Float32Array.from({ length: n }, (_, i) => 2 * ((i * bin % n) / n) - 1);
    const alias = spectralResidual(actual, bin), baseline = spectralResidual(naive, bin);
    aliasMeasurements.push({ rate, bin, aliasDb: 20 * Math.log10(alias), improvementDb: 20 * Math.log10(baseline / alias) });
    expect(alias).toBeLessThan(baseline / 4); // >=12 dB less folded RMS than naive saw.
    if (bin === 37) expect(alias).toBeLessThan(0.0032); // -50 dBFS RMS at bass/pad pitch.
    // Four convolved boxes have sinc⁴ frequency response.
    let fundamental = 0;
    for (let i = 0; i < n; i++) fundamental += actual[i] * Math.sin(2 * Math.PI * bin * i / n) * 2 / n;
    const x = Math.PI * bin / n;
    expect(Math.abs(fundamental + 2 / Math.PI * (Math.sin(x) / x) ** 4)).toBeLessThan(0.002);
  }
}, 60000);

for (const rate of rates) test(`filter steady-state response, resonance level and decay at ${rate}`, async () => {
  const n = 32768, cutoff = 1000;
  for (const q of [0.5, Math.SQRT1_2, 10]) for (const frequency of [250, 1000, 8000]) {
    const input = Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * frequency * i / rate));
    const actual = (await render(rate, [input, fill(n, cutoff), fill(n, q), fill(n, 0)])).outputs.main[0];
    const referenceOutput = reference(input, rate, cutoff, Math.fround(q));
    expect(maxError(actual, referenceOutput)).toBeLessThan(2e-6);
    const u = Math.tan(Math.PI * frequency / rate) / Math.tan(Math.PI * cutoff / rate);
    const gain = 1 / Math.hypot(1 - u * u, u / q);
    const from = n / 2;
    const rms = (x: ArrayLike<number>) => Math.sqrt(Array.from({ length: n - from }, (_, i) => x[i + from] ** 2).reduce((a, b) => a + b, 0) / (n - from));
    expect(Math.abs(rms(actual) / rms(input) - gain)).toBeLessThan(0.02);
    expect(peak(actual)).toBeLessThan(11);
  }
  const impulse = fill(n, 0); impulse[0] = 1;
  const tail = (await render(rate, [impulse, fill(n, 20), fill(n, 10), fill(n, 0)])).outputs.main[0];
  // At the slowest pole, envelope decays as exp(-pi*20*t/10).
  expect(peak(tail.slice(-1024))).toBeLessThan(0.002);
}, 60000);

test('construction rejects invalid sample rates and waveform', () => {
  for (const rate of [NaN, Infinity, 0, 7999, 192001]) for (const wave of [undefined, 'sine'] as const) {
    expect(() => fixture(rate, wave)).toThrow(/sampleRate/);
  }
  expect(() => fixture(48000, 'invalid' as 'sine')).toThrow(/waveform/);
});

for (const rate of rates) test(`filter reset sample consumes new input; DC gain and counterexample at ${rate}`, async () => {
  const n = 4096, input = fill(n, 1), reset = fill(n, 0); reset[129] = 1;
  const actual = (await render(rate, [input, fill(n, 1000), fill(n, 0.5), reset])).outputs.main[0];
  const expected = reference(input, rate, 1000, 0.5);
  expect(maxError(actual.slice(129), expected.slice(0, n - 129))).toBeLessThan(2e-6);
  expect(Math.abs(actual[n - 1] - 1)).toBeLessThan(1e-6);
  // A bypass or missing reset must not satisfy the independent oracle.
  expect(maxError(input, expected)).toBeGreaterThan(0.9);
  expect(maxError(actual.slice(129), expected.slice(129))).toBeGreaterThan(0.5);
}, 60000);
