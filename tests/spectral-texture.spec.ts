import { expect, test } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate, type CompiledProcessor } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { spectralBlur, spectralCrossSynthesis } from '../src/spectral-texture.js';
import { stftIdentity } from '../src/spectral.js';
import { blurSpectrum, crossSpectrum, directDft, directTextureWola, maxError } from './spectral-texture-oracle.mjs';

type Mode = 'blur' | 'cross' | 'identity';
function fixture(size: number, hopSize: number, mode: Mode, option = mode === 'blur' ? Math.min(3, size / 2 - 1) : 4) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 4, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
    if (mode === 'identity') {
      const unit = instantiate(stftIdentity, { size, hopSize }, { name: 'unit' });
      return { process() { forSample((i, every) => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), input.ch(3).at(i).gt(0), every))); } };
    }
    if (mode === 'blur') {
      const unit = instantiate(spectralBlur, { size, hopSize, radius: option }, { name: 'unit' });
      return { process() { forSample((i, every) => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), input.ch(2).at(i), input.ch(3).at(i).gt(0), every))); } };
    }
    const unit = instantiate(spectralCrossSynthesis, { size, hopSize, maxGain: option }, { name: 'unit' });
    return { process() { forSample((i, every) => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), input.ch(1).at(i), input.ch(2).at(i), input.ch(3).at(i).gt(0), every))); } };
  });
}
const render = (p: CompiledProcessor, rate: number, input: Float32Array[], restore?: Uint8Array) => renderOffline(p, {
  sampleRate: rate, duration: (input[0].length - 0.25) / rate, inputs: { main: input }, restore,
});
const data = (size: number, count: number) => [
  Float32Array.from({ length: count }, (_, n) => 0.33 * Math.sin(2 * Math.PI * 2.375 * n / size) + 0.21 * Math.cos(2 * Math.PI * 3 * n / size) + (n % 137 === 0 ? 0.25 : 0)),
  Float32Array.from({ length: count }, (_, n) => 0.29 * Math.cos(2 * Math.PI * 1.125 * n / size) - 0.24 * Math.sin(2 * Math.PI * 3 * n / size) - (n % 191 === 0 ? 0.31 : 0)),
  new Float32Array(count).fill(0.7), new Float32Array(count),
];

for (const rate of [44100, 48000, 96000]) {
  test(`textures match independent DFT/WOLA through every small reset offset at ${rate}`, async () => {
    for (const size of [8, 16, 64]) for (const hop of [size / 2, size / 4]) {
      const count = Math.ceil((hop * (size + hop + 1) + 5 * size) / 128) * 128, input = data(size, count);
      for (let phase = 0; phase < hop; phase++) input[3][2 * size + phase * (size + hop + 1)] = 1;
      input[3].fill(1, 127, 132);
      for (let n = 0; n < count; n++) input[2][n] = [0, 0.3, 1, -1, 2, NaN, Infinity, -Infinity][Math.floor(n / (hop + 1)) % 8];
      for (const mode of ['blur', 'cross'] as const) {
        const option = mode === 'blur' ? Math.min(3, size / 2 - 1) : 4;
        const result = await render(fixture(size, hop, mode, option), rate, input);
        expect(maxError(result.outputs.main[0], directTextureWola(input, size, hop, mode, option))).toBeLessThan(3e-7);
        expect(result.diagnostics.scrubbedSamples).toBe(0);
      }
    }
  }, 60000);

  test(`N256 maximum textures retain native state for both hops at ${rate}`, async () => {
    for (const hop of [64, 128]) for (const mode of ['blur', 'cross'] as const) {
      const size = 256, input = data(size, 2048), option = mode === 'blur' ? 8 : 16;
      input[3][255] = 1; input[3].fill(1, 1023, 1155);
      input[2].fill(1, 384, 895); input[2].fill(0, 1535);
      const p = fixture(size, hop, mode, option), whole = await render(p, rate, input);
      expect(maxError(whole.outputs.main[0], directTextureWola(input, size, hop, mode, option))).toBeLessThan(3e-7);
      for (const split of [128, 256, 896, 1024, 1152, 1280, 1664]) {
        const first = await render(p, rate, input.map(x => x.slice(0, split)));
        const resumed = await render(p, rate, input.map(x => x.slice(split)), first.state);
        expect(resumed.outputs.main[0]).toEqual(whole.outputs.main[0].slice(split));
        expect(resumed.state).toEqual(whole.state); expect(resumed.diagnostics.scrubbedSamples).toBe(0);
      }
      expect(whole.outputs.main[0].slice(1023, 1156).every(x => x === 0)).toBe(true);
      expect(whole.diagnostics.scrubbedSamples).toBe(0);
    }
  }, 60000);

  test(`small-hop classes restore pending and held resets exactly at ${rate}`, async () => {
    for (const [size, hop] of [[8, 2], [8, 4], [16, 8], [32, 16], [64, 32]]) for (const mode of ['blur', 'cross'] as const) {
      const input = data(size, 768), p = fixture(size, hop, mode);
      input[3][127] = 1; input[3].fill(1, 255, 387); input[2].fill(1, 384);
      const whole = await render(p, rate, input);
      for (const split of [128, 256, 384, 512]) {
        const first = await render(p, rate, input.map(x => x.slice(0, split)));
        const resumed = await render(p, rate, input.map(x => x.slice(split)), first.state);
        expect(resumed.outputs.main[0]).toEqual(whole.outputs.main[0].slice(split));
        expect(resumed.state).toEqual(whole.state); expect(resumed.diagnostics.scrubbedSamples).toBe(0);
      }
    }
  }, 60000);

  test(`amount-zero bypass preserves identity PCM, resets, extrema and subnormals at ${rate}`, async () => {
    for (const [size, hop] of [[8, 2], [64, 32], [256, 128]]) {
      const input = data(size, 1024);
      input[0] = Float32Array.from(input[0], (_, n) => [2 ** -149, -(2 ** -130), 1e-29, -1, 0.5, 1][n % 6]);
      input[3][127] = 1; input[3].fill(1, 255, 259);
      input[2] = Float32Array.from(input[2], (_, n) => [0, NaN, -Infinity, -1][n % 4]);
      const expected = await render(fixture(size, hop, 'identity'), rate, input);
      for (const mode of ['blur', 'cross'] as const) {
        const actual = await render(fixture(size, hop, mode), rate, input);
        expect(actual.outputs.main[0]).toEqual(expected.outputs.main[0]); expect(actual.diagnostics.scrubbedSamples).toBe(0);
      }
    }
  }, 60000);

  test(`active tiny textures, normalized peaks and exact finite drain at ${rate}`, async () => {
    for (const amplitude of [2 ** -149, 2 ** -130, 1e-29, 1]) for (const mode of ['blur', 'cross'] as const) {
      const size = 64, hop = 16, input = data(size, 1024), option = mode === 'blur' ? 3 : 4;
      input[0] = Float32Array.from(input[0], (_, n) => (n % 3 ? 1 : -1) * amplitude);
      input[1] = Float32Array.from(input[1], (_, n) => (n % 7 ? 1 : -1) * amplitude);
      input[2].fill(1); input[0].fill(0, 769); input[1].fill(0, 769);
      const actual = await render(fixture(size, hop, mode), rate, input);
      const expected = Float32Array.from(directTextureWola(input, size, hop, mode, option));
      expect(maxError(actual.outputs.main[0], expected)).toBeLessThanOrEqual(Math.max(2 ** -149, amplitude * 3e-7));
      expect(actual.outputs.main[0].slice(769 + 2 * size).every(x => x === 0)).toBe(true);
      expect(Math.max(...actual.outputs.main[0].map(Math.abs))).toBeLessThanOrEqual(2 * Math.sqrt(size) * amplitude);
      expect(actual.outputs.main[0].some(x => x !== 0)).toBe(true); expect(actual.diagnostics.scrubbedSamples).toBe(0);
    }
  }, 60000);
}

test('cross carrier zero/near-zero and modulator zero obey capped magnitude replacement', async () => {
  const size = 64, hop = 16, input = data(size, 1024), p = fixture(size, hop, 'cross', 4);
  input[2].fill(1);
  for (const amplitude of [0, 2 ** -149, 2 ** -130, 1e-29, 1e-9, 0.125]) {
    input[0] = Float32Array.from(input[0], (_, n) => (n % 3 ? 1 : -1) * amplitude);
    input[1] = Float32Array.from(input[1], (_, n) => (n % 3 ? 1 : -1) * 0.75);
    const actual = await render(p, 48000, input), delayed = await render(fixture(size, hop, 'identity'), 48000, input);
    expect(maxError(actual.outputs.main[0], Float32Array.from(delayed.outputs.main[0], x => x * 4))).toBeLessThanOrEqual(Math.max(4 * 2 ** -149, amplitude * 3e-7));
    expect(actual.diagnostics.scrubbedSamples).toBe(0);
    if (!amplitude) expect(actual.outputs.main[0].every(x => x === 0)).toBe(true);
  }
  input[0] = data(size, 1024)[0]; input[1].fill(0);
  expect((await render(p, 48000, input)).outputs.main[0].every(x => x === 0)).toBe(true);
  input[2].fill(0.25);
  const partial = await render(p, 48000, input), identity = await render(fixture(size, hop, 'identity'), 48000, input);
  expect(maxError(partial.outputs.main[0], Float32Array.from(identity.outputs.main[0], x => x * 0.75))).toBeLessThan(1e-7);
  input[1].set(input[0]); input[2].fill(1);
  expect(maxError((await render(p, 48000, input)).outputs.main[0], identity.outputs.main[0])).toBeLessThan(1e-7);
});

test('dual frames preserve tap statements, synchronous impulses and current-sample exclusion', async () => {
  const size = 64, hop = 16, input = data(size, 1024), p = fixture(size, hop, 'cross', 4);
  const counters: Record<string, unknown>[] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.kind === 'everyNSamples') counters.push(record);
    for (const child of Object.values(record)) if (Array.isArray(child)) child.forEach(walk); else walk(child);
  };
  walk(p.__capture(48000));
  expect(counters).toHaveLength(2); expect(counters.map(x => x.divisor)).toEqual([hop, hop]);
  expect(counters[0].counterId).not.toBe(counters[1].counterId);
  expect(JSON.stringify(counters[0])).toContain('unit/modulator/magnitudesScaled');
  expect(JSON.stringify(counters[1])).toContain('unit/modulator/magnitudesScaled');
  input[0].fill(0); input[1].fill(0); input[2].fill(1);
  for (const [at, carrier, modulator] of [[129, 0.5, -0.8], [277, -0.6, 0.3], [418, 0.3, -0.4], [635, 0.8, 0.1]]) {
    input[0][at] = carrier; input[1][at] = modulator;
  }
  const actual = await render(p, 48000, input);
  expect(maxError(actual.outputs.main[0], directTextureWola(input, size, hop, 'cross', 4))).toBeLessThan(1e-7);
  const shifted = input.map(x => x.slice()); shifted[1].fill(0); shifted[1].set(input[1].slice(0, -hop), hop);
  expect(maxError(actual.outputs.main[0], directTextureWola(shifted, size, hop, 'cross', 4))).toBeGreaterThan(0.02);
  expect(maxError((await render(p, 48000, shifted)).outputs.main[0], directTextureWola(shifted, size, hop, 'cross', 4))).toBeLessThan(1e-7);
  const changed = input.map(x => x.slice()); changed[0][256] = 1; changed[1][256] = -1;
  const b = await render(p, 48000, changed);
  expect(b.outputs.main[0].slice(0, 256 + hop)).toEqual(actual.outputs.main[0].slice(0, 256 + hop));
  expect(b.outputs.main[0]).not.toEqual(actual.outputs.main[0]);
});

test('between-frame amount edits are ignored for both textures', async () => {
  const size = 64, hop = 16, a = data(size, 1024), b = a.map(x => x.slice());
  for (let n = 0; n < b[2].length; n++) if (n % hop) b[2][n] = n % 2 ? NaN : 1;
  for (const mode of ['blur', 'cross'] as const) {
    const p = fixture(size, hop, mode), first = await render(p, 48000, a), second = await render(p, 48000, b);
    expect(second.outputs.main[0]).toEqual(first.outputs.main[0]);
    const edge = b.map(x => x.slice()); edge[2][512] = 0;
    const edited = await render(p, 48000, edge);
    expect(edited.outputs.main[0]).not.toEqual(first.outputs.main[0]);
    expect(maxError(edited.outputs.main[0], directTextureWola(edge, size, hop, mode, mode === 'blur' ? 3 : 4))).toBeLessThan(2e-7);
  }
});

test('circular triangle calibration, endpoint signs, floor equality and the explicit phase jump', () => {
  const size = 16, radius = 1, threshold = 2 ** -20;
  const spectrum = [new Float64Array(size), new Float64Array(size)];
  spectrum[0][3] = spectrum[0][size - 3] = 1;
  for (const targetBin of [0, 4, size / 2]) for (const factor of [0, 0.5, 1, 2]) {
    const input = spectrum.map(x => x.slice()); input[0][targetBin] = -threshold * factor;
    if (targetBin) input[0][size - targetBin] = input[0][targetBin];
    const result = blurSpectrum(input, radius, 1);
    expect(result[1][0]).toBe(0); expect(result[1][size / 2]).toBe(0);
    if (factor < 1) expect(result[0][targetBin]).toBeGreaterThanOrEqual(0);
    else expect(result[0][targetBin]).toBeLessThan(0);
  }
  const isolated = [new Float64Array(size), new Float64Array(size)]; isolated[0][0] = 1;
  const atDc = blurSpectrum(isolated, 1, 1);
  expect(atDc[0][0]).toBe(0.5); expect(atDc[0][1]).toBe(0.25); expect(atDc[0][size - 1]).toBe(0.25);
  isolated[0][0] = 0; isolated[0][size / 2] = 1;
  const atNyquist = blurSpectrum(isolated, 1, 1);
  expect(atNyquist[0][size / 2]).toBe(0.5); expect(atNyquist[0][size / 2 - 1]).toBe(0.25); expect(atNyquist[0][size / 2 + 1]).toBe(0.25);
  const justBelow = spectrum.map(x => x.slice()), at = spectrum.map(x => x.slice());
  justBelow[0][4] = justBelow[0][12] = -threshold * (1 - 2 ** -20);
  at[0][4] = at[0][12] = -threshold;
  const low = blurSpectrum(justBelow, 1, 1), high = blurSpectrum(at, 1, 1);
  const target = 0.25 + threshold / 2;
  expect(Math.abs(high[0][4] - low[0][4])).toBeCloseTo(2 * target, 10);
  // A non-real retained phase exercises both complex components of the jump.
  for (const phase of [Math.PI / 3, -Math.PI / 2]) {
    const input = spectrum.map(x => x.slice());
    input[0][4] = input[0][12] = 2 * threshold * Math.cos(phase);
    input[1][4] = 2 * threshold * Math.sin(phase); input[1][12] = -input[1][4];
    const retained = blurSpectrum(input, 1, 1), zeroPhase = blurSpectrum(input, 1, 1, 1);
    const jump = Math.hypot(retained[0][4] - zeroPhase[0][4], retained[1][4] - zeroPhase[1][4]);
    expect(jump).toBeCloseTo(2 * (0.25 + threshold) * Math.abs(Math.sin(phase / 2)), 12);
  }
  // Rejected exact-nonzero design: a sign choice at roundoff size directs a
  // quarter-unit redistributed bin, despite a 2e-15 change to the input bin.
  const positive = spectrum.map(x => x.slice()), negative = spectrum.map(x => x.slice());
  positive[0][4] = positive[0][12] = 1e-15; negative[0][4] = negative[0][12] = -1e-15;
  expect(Math.abs(blurSpectrum(positive, 1, 1, 0)[0][4] - blurSpectrum(negative, 1, 1, 0)[0][4])).toBeGreaterThan(0.49);
  expect(blurSpectrum(positive, 1, 1)).toEqual(blurSpectrum(negative, 1, 1));
  // Modulator phase is excluded; this is magnitude replacement, not a complex product.
  const phased = spectrum.map(x => x.slice()); phased[0][3] = phased[0][13] = 0; phased[1][3] = 1; phased[1][13] = -1;
  expect(maxError(crossSpectrum(spectrum, spectrum, 4, 1)[0], crossSpectrum(spectrum, phased, 4, 1)[0])).toBe(0);
});

test('native blur retains relative phase policy under full-frame scaling and weak two-tone changes', async () => {
  const size = 64, hop = 16, count = 1024, p = fixture(size, hop, 'blur', 3);
  const template = data(size, count); template[2].fill(1);
  // A real-valued conjugate-symmetric spectrum with imaginary strong/weak bins
  // has inverse-frame sample0=0 and can be divided by the analysis window.
  const ratios = [];
  for (const factor of [0, 0.5, 1, 2]) {
    const re = new Float64Array(size), im = new Float64Array(size);
    im[3] = 1; im[size - 3] = -1; im[4] = -(2 ** -20) * factor; im[size - 4] = -im[4];
    const frame = directDft(re, im, true)[0];
    template[0] = Float32Array.from({ length: count }, (_, n) => n % size ? frame[n % size] / Math.sin(Math.PI * (n % size) / size) : 0);
    // Float32 input makes an exact frequency-domain threshold generally
    // unrepresentable; the independent oracle measures the actual input bins.
    let baseOutput: Float32Array | undefined, baseRatio = 0;
    for (const scale of [1, 2 ** -100, 2 ** -130]) {
      const input = template.map(x => x.slice()); input[0] = Float32Array.from(input[0], x => x * scale);
      const analyzed = directDft(Float64Array.from({ length: size }, (_, n) => input[0][n] * Math.sin(Math.PI * n / size)), new Float64Array(size));
      const amplitudes = Float64Array.from(analyzed[0], (x, k) => Math.hypot(x, analyzed[1][k]));
      const actualFloorRatio = amplitudes[4] / (Math.max(...amplitudes) * 2 ** -20);
      ratios.push({ factor, scale, actualFloorRatio });
      if (scale === 1) {
        baseRatio = actualFloorRatio;
        if (factor === 0) expect(actualFloorRatio).toBeLessThan(0.05);
        else expect(Math.abs(actualFloorRatio - factor)).toBeLessThan(0.03);
      } else if (scale === 2 ** -100) expect(actualFloorRatio).toBeCloseTo(baseRatio, 10);
      const actual = await render(p, 48000, input), expected = Float32Array.from(directTextureWola(input, size, hop, 'blur', 3));
      expect(maxError(actual.outputs.main[0], expected)).toBeLessThanOrEqual(Math.max(2 ** -149, scale * 2e-7));
      if (scale === 1) baseOutput = actual.outputs.main[0];
      else if (scale === 2 ** -100) expect(actual.outputs.main[0]).toEqual(Float32Array.from(baseOutput!, x => x * scale));
      expect(actual.diagnostics.scrubbedSamples).toBe(0);
    }
  }
  console.info(JSON.stringify({ measuredPhaseFloorRatios: ratios, note: 'Subnormal f32 rescaling may quantize the actual input and change the ratio; it does not change the fixed threshold.' }));
});

test('construction limits reject unsupported sizes, hops, radii and gain caps', () => {
  for (const mode of ['blur', 'cross'] as const) for (const [size, hop] of [[0, 0], [7, 2], [12, 6], [512, 128], [16, 3], [16, 16], [NaN, 4]]) expect(() => fixture(size, hop, mode)).toThrow(RangeError);
  for (const radius of [-1, 0, 1.5, 9, NaN, Infinity]) expect(() => fixture(64, 16, 'blur', radius)).toThrow(RangeError);
  expect(() => fixture(8, 2, 'blur', 4)).toThrow(RangeError);
  for (const gain of [0, 0.99, 16.01, NaN, Infinity, -Infinity]) expect(() => fixture(64, 16, 'cross', gain)).toThrow(RangeError);
});
