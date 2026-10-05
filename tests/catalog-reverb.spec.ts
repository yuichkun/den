import { test, expect } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate, type CompiledProcessor } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { algorithmicReverb, type AlgorithmicReverbConfig } from '../src/reverb.js';

const rates = [44100, 48000, 96000];
function fixture(config: Partial<AlgorithmicReverbConfig> = {}, dampingAtCeiling = false) {
  return defineProcessor(ctx => {
    const input = audioInput({ channels: 3, name: 'main' }), output = audioOutput({ channels: 2, name: 'main' });
    const fx = instantiate(algorithmicReverb, { ...config, dampingHz: dampingAtCeiling ? 0.45 * ctx.sampleRate : config.dampingHz, sampleRate: ctx.sampleRate }, { name: 'reverb' });
    return { process() { forSample(i => {
      const r = fx.tick(input.ch(0).at(i), input.ch(1).at(i), { mix: input.ch(0).at(i).mul(0).add(1), bypass: i.lt(0), reset: input.ch(2).at(i).gt(0) });
      output.ch(0).at(i).write(r.left); output.ch(1).at(i).write(r.right);
    }); } };
  });
}
async function render(p: CompiledProcessor, rate: number, left: Float32Array, right = new Float32Array(left.length), reset = new Float32Array(left.length)) {
  const r = await renderOffline(p, { sampleRate: rate, duration: left.length / rate, inputs: { main: [left, right, reset] } });
  expect(r.diagnostics.scrubbedSamples).toBe(0);
  expect(r.outputs.main.every(a => a.every(Number.isFinite))).toBe(true);
  return r.outputs.main;
}
const energy = (a: ArrayLike<number>) => Array.from(a).reduce((s, x) => s + x * x, 0);
const matrix = [[1, 1, 1, 1], [1, -1, 1, -1], [1, 1, -1, -1], [1, -1, -1, 1]];
// Independent unbounded time-domain construction. It has no ring-buffer indices,
// no subgraph states and uses JS doubles for the one-pole and matrix arithmetic.
function reference(rate: number, config: Partial<AlgorithmicReverbConfig>, left: Float32Array, right: Float32Array, resets: Float32Array) {
  const lengths = [0.0297, 0.0371, 0.0411, 0.0437].map(t => Math.round(t * (config.roomScale ?? 1) * rate));
  const gains = lengths.map(d => 10 ** (-3 * d / (rate * (config.decaySeconds ?? 1.5))));
  const times = lengths.map(d => Math.min(d, Math.fround(d / rate) * rate));
  const pole = Math.exp(-2 * Math.PI * (config.dampingHz ?? 6000) / rate);
  const histories = Array.from({ length: 4 }, () => new Float64Array(left.length)), damped = [0, 0, 0, 0];
  const out = [new Float32Array(left.length), new Float32Array(left.length)]; let start = 0;
  for (let n = 0; n < left.length; n++) {
    if (resets[n] > 0) { start = n; damped.fill(0); }
    const raw = times.map((delay, ch) => {
      const position = n - delay, lo = Math.floor(position), frac = position - lo;
      const at = (i: number) => i >= start && i < n ? histories[ch][i] : 0;
      return Math.fround(at(lo) * (1 - frac) + at(lo + 1) * frac);
    });
    for (let ch = 0; ch < 4; ch++) damped[ch] = pole * damped[ch] + (1 - pole) * raw[ch];
    for (let ch = 0; ch < 4; ch++) histories[ch][n] = Math.fround((left[n] + matrix[1][ch] * right[n]) / 2 + damped.reduce((s, v, j) => s + matrix[ch][j] * gains[j] * v / 2, 0));
    for (let ch = 0; ch < 2; ch++) out[ch][n] = raw.reduce((s, v, j) => s + matrix[ch + 2][j] * v / 2, 0);
  }
  return out;
}
function maxError(a: Float32Array, b: Float32Array) { let e = 0; for (let i = 0; i < a.length; i++) e = Math.max(e, Math.abs(a[i] - b[i])); return e; }

for (const rate of rates) {
  test(`FDN impulse timing and damped dense-matrix timeline at ${rate}`, async () => {
    for (const config of [{ roomScale: 0.5, decaySeconds: 0.1, dampingHz: 20 }, { roomScale: 1, decaySeconds: 0.6, dampingHz: 2000 }, { roomScale: 2, decaySeconds: 10, dampingHz: rate * 0.45 }]) {
      const size = 32768, left = Float32Array.from({ length: size }, (_, n) => n % 8192 === 0 ? 1 : n < 1000 ? Math.sin(n * 0.37) * 0.1 : 0);
      const right = Float32Array.from({ length: size }, (_, n) => n === 37 ? -0.5 : 0), reset = new Float32Array(size); reset[16383] = 1; reset[16384] = 1;
      const actual = await render(fixture(config, config.dampingHz === rate * 0.45), rate, left, right, reset), expected = reference(rate, config, left, right, reset);
      for (let ch = 0; ch < 2; ch++) expect(maxError(actual[ch], expected[ch])).toBeLessThan(4e-6);
    }
    const impulse = new Float32Array(8192); impulse[0] = 1;
    const actual = await render(fixture(), rate, impulse);
    const lengths = [0.0297, 0.0371, 0.0411, 0.0437].map(t => Math.round(t * rate));
    expect(actual[0].slice(0, lengths[0] - 1).every(x => x === 0)).toBe(true);
    for (let tap = 0; tap < 4; tap++) {
      // First arrivals precede all recirculation; each orthonormal projection is ±1/4.
      const nearby = actual[0].slice(lengths[tap] - 1, lengths[tap] + 2).reduce((s, x) => s + x, 0);
      expect(Math.abs(nearby - matrix[2][tap] / 4)).toBeLessThan(1e-6);
    }
  });

  test(`FDN orthogonal network has bounded impulse energy, increasing echo density and retained mono energy at ${rate}`, async () => {
    const decaySeconds = 0.6, impulse = new Float32Array(2 ** 18); impulse[0] = 1;
    const output = await render(fixture({ decaySeconds, dampingHz: 2000 }), rate, impulse);
    const gmax = 10 ** (-3 * Math.round(0.0297 * rate) / (rate * decaySeconds));
    const total = energy(output[0]) + energy(output[1]);
    // Conservative small-gain bound, independent of implementation recurrence.
    expect(total).toBeLessThanOrEqual(1 / (1 - gmax) ** 2);
    expect(total).toBeGreaterThan(0.1);
    const mono = Float32Array.from(output[0], (x, n) => (x + output[1][n]) / Math.SQRT2);
    expect(energy(mono)).toBeGreaterThan(total * 0.1);
    expect(energy(mono)).toBeLessThanOrEqual(total * 1.000001);
    const early = output[0].slice(Math.round(0.03 * rate), Math.round(0.08 * rate));
    const late = output[0].slice(Math.round(0.3 * rate), Math.round(0.35 * rate));
    const occupied = (a: Float32Array) => a.filter(x => Math.abs(x) > 1e-8).length / a.length;
    expect(occupied(late)).toBeGreaterThan(occupied(early));
    expect(energy(output[0].slice(-4096)) + energy(output[1].slice(-4096))).toBeLessThan(total * 1e-10);
    const covariance = output[0].reduce((s, x, n) => s + x * output[1][n], 0);
    expect(Math.abs(covariance / Math.sqrt(energy(output[0]) * energy(output[1])))).toBeLessThan(0.95);
    console.log(JSON.stringify({ rate, totalImpulseEnergy: total, monoEnergy: energy(mono), earlyOccupancy: occupied(early), lateOccupancy: occupied(late) }));
  });

  test(`FDN frequency-band decay measures construction RT60 and shorter damped high tail at ${rate}`, async () => {
    const decaySeconds = 0.6, impulse = new Float32Array(2 ** 17); impulse[0] = 1;
    const output = await render(fixture({ decaySeconds, dampingHz: 2000 }), rate, impulse);
    const low = estimateDecay(output, rate, [125, 175, 250, 350, 500], 0.12, 0.48);
    const high = estimateDecay(output, rate, [4000, 5000, 6000, 7000, 8000], 0.07, 0.18);
    // These tolerance bands are fixed before measuring. The nominal time is a
    // low-frequency network target, not a promise of identical modal slopes.
    expect(low).toBeGreaterThan(0.45); expect(low).toBeLessThan(0.75);
    expect(high).toBeGreaterThan(0.03); expect(high).toBeLessThan(low * 0.65);
    console.log(JSON.stringify({ rate, targetLowRt60Seconds: decaySeconds, measuredLowBandRt60Seconds: low, measuredHighBandRt60Seconds: high }));
  });
}

function estimateDecay(audio: Float32Array[], rate: number, frequencies: number[], from: number, to: number) {
  const size = 2048, hop = 512;
  const kernels = frequencies.map(f => ({ re: Float64Array.from({ length: size }, (_, n) => (0.5 - 0.5 * Math.cos(2 * Math.PI * n / (size - 1))) * Math.cos(2 * Math.PI * f * n / rate)), im: Float64Array.from({ length: size }, (_, n) => (0.5 - 0.5 * Math.cos(2 * Math.PI * n / (size - 1))) * Math.sin(2 * Math.PI * f * n / rate)) }));
  const points: { t: number; db: number }[] = [];
  for (let start = 0; start + size <= audio[0].length; start += hop) {
    const t = (start + size / 2) / rate; if (t < from || t > to) continue;
    let power = 0;
    for (const channel of audio) for (const k of kernels) {
      let re = 0, im = 0; for (let n = 0; n < size; n++) { re += channel[start + n] * k.re[n]; im += channel[start + n] * k.im[n]; }
      power += re * re + im * im;
    }
    points.push({ t, db: 10 * Math.log10(Math.max(1e-40, power)) });
  }
  const meanT = points.reduce((s, p) => s + p.t, 0) / points.length, meanDb = points.reduce((s, p) => s + p.db, 0) / points.length;
  const slope = points.reduce((s, p) => s + (p.t - meanT) * (p.db - meanDb), 0) / points.reduce((s, p) => s + (p.t - meanT) ** 2, 0);
  return -60 / slope;
}

test('FDN longest decay survives sustained stereo excitation and clears its long tail without scrubbing', async () => {
  const rate = 48000, size = 2 ** 21, signal = Float32Array.from({ length: size }, (_, n) => n < rate ? Math.sin(2 * Math.PI * 211 * n / rate) * 0.5 : 0);
  const right = Float32Array.from(signal, (_, n) => n < rate ? Math.cos(2 * Math.PI * 317 * n / rate) * 0.5 : 0);
  const output = await render(fixture({ roomScale: 0.5, decaySeconds: 10, dampingHz: 20000 }), rate, signal, right);
  const early = energy(output[0].slice(0, rate * 2)) + energy(output[1].slice(0, rate * 2));
  const tail = energy(output[0].slice(-rate)) + energy(output[1].slice(-rate));
  expect(early).toBeGreaterThan(1);
  expect(tail).toBeLessThan(early * 1e-12);
}, 30000);
