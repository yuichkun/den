import { expect, test } from 'vitest';
import { audioInput, audioOutput, defineProcessor, f32, f64, forSample, instantiate, state, type CompiledProcessor } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { spectralFft, spectralForEach } from '../src/spectral-fft.js';
import { stftIdentity } from '../src/spectral.js';

const rates = [44100, 48000, 96000];
const render = (processor: CompiledProcessor, sampleRate: number, input: Float32Array[], restore?: Uint8Array) =>
  renderOffline(processor, { sampleRate, duration: (input[0].length - 0.25) / sampleRate, inputs: { main: input }, restore });
function directDft(real: ArrayLike<number>, imag: ArrayLike<number>, inverse = false) {
  const size = real.length, sign = inverse ? 1 : -1, scale = inverse ? 1 / size : 1;
  const out = [new Float64Array(size), new Float64Array(size)];
  for (let k = 0; k < size; k++) for (let n = 0; n < size; n++) {
    const angle = sign * 2 * Math.PI * k * n / size, c = Math.cos(angle), s = Math.sin(angle);
    out[0][k] += scale * (real[n] * c - imag[n] * s);
    out[1][k] += scale * (real[n] * s + imag[n] * c);
  }
  return out;
}
function fftFixture(size: number) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 2, name: 'main' }), output = audioOutput({ channels: 4, name: 'main' });
    const real = state.buffer.f64({ size }), imag = state.buffer.f64({ size });
    const result = Array.from({ length: 4 }, () => state.buffer.f64({ size }));
    const cursor = state.i32(0);
    const fft = instantiate(spectralFft, { size }, { name: 'fft' });
    return { process() { forSample((i, everyNSamples) => {
      everyNSamples(size, () => {
        for (const inverse of [false, true]) {
          const transformed = fft.transform(n => real.read(n), n => imag.read(n), inverse);
          spectralForEach(size, k => {
            result[inverse ? 2 : 0].write(k, transformed.real(k));
            result[inverse ? 3 : 1].write(k, transformed.imag(k));
          });
        }
      });
      for (let ch = 0; ch < 4; ch++) output.ch(ch).at(i).write(f32(result[ch].read(cursor.read())));
      real.write(cursor.read(), f64(input.ch(0).at(i))); imag.write(cursor.read(), f64(input.ch(1).at(i)));
      cursor.write(cursor.read().add(1).mod(size));
    }); } };
  });
}
function stftFixture(size: number, hopSize: number) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 2, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
    const stft = instantiate(stftIdentity, { size, hopSize }, { name: 'stft' });
    return { process() { forSample((i, everyNSamples) => {
      output.ch(0).at(i).write(stft.tick(input.ch(0).at(i), input.ch(1).at(i).gt(0), everyNSamples));
    }); } };
  });
}
// Independent time-indexed DFT/WOLA. No ring buffers, radix butterflies or
// implementation state recurrence. Reset removes all scheduled pre-reset tails.
function directWola(input: Float32Array, resets: Float32Array, size: number, hop: number) {
  const output = new Float64Array(input.length + size), window = Float64Array.from({ length: size }, (_, n) => Math.sin(Math.PI * n / size));
  let resetAt = -1;
  for (let t = 0; t < input.length; t++) {
    if (resets[t] > 0) { resetAt = t; output.fill(0, t); }
    if (t % hop !== 0) continue;
    const frame = Float64Array.from(window, (w, n) => t - size + n > resetAt ? input[t - size + n] * w : 0);
    const spectrum = directDft(frame, new Float64Array(size));
    const reconstructed = directDft(spectrum[0], spectrum[1], true);
    for (let n = 0; n < size; n++) output[t + n] += reconstructed[0][n] * window[n] * 2 * hop / size;
    if (resets[t] > 0) output[t] = 0;
  }
  return output.slice(0, input.length);
}
const maxError = (actual: ArrayLike<number>, expected: ArrayLike<number>) => {
  let error = 0; for (let n = 0; n < actual.length; n++) error = Math.max(error, Math.abs(actual[n] - expected[n])); return error;
};

for (const rate of rates) {
  test(`radix FFT signs/layout/normalization match independent DFT at ${rate}`, async () => {
    for (const size of [8, 16, 32, 64]) {
      let seed = 123;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 * 2 - 1; };
      const cases = [
        [Float32Array.from({ length: size }, (_, n) => Number(n === 0)), new Float32Array(size)],
        [new Float32Array(size).fill(0.5), new Float32Array(size)],
        [Float32Array.from({ length: size }, (_, n) => n % 2 ? -1 : 1), new Float32Array(size)],
        ...[1, -1, 2.375].map(bin => [Float32Array.from({ length: size }, (_, n) => Math.cos(2 * Math.PI * bin * n / size)), Float32Array.from({ length: size }, (_, n) => Math.sin(2 * Math.PI * bin * n / size))]),
        [Float32Array.from({ length: size }, random), Float32Array.from({ length: size }, random)],
        [Float32Array.from({ length: size }, random), new Float32Array(size)],
      ];
      const frames = Math.ceil((cases.length + 1) * size / 128) * 128;
      const input = [new Float32Array(frames), new Float32Array(frames)];
      cases.forEach((value, n) => value.forEach((v, ch) => input[ch].set(v, n * size)));
      const result = await render(fftFixture(size), rate, input);
      expect(result.diagnostics.scrubbedSamples).toBe(0);
      for (let c = 0; c < cases.length; c++) for (const inverse of [false, true]) {
        const expected = directDft(cases[c][0], cases[c][1], inverse), start = (c + 1) * size;
        for (let ch = 0; ch < 2; ch++) expect(maxError(result.outputs.main[(inverse ? 2 : 0) + ch].slice(start, start + size), expected[ch])).toBeLessThan(4e-6);
      }
      // Explicit real-signal conjugate symmetry, DC and Nyquist imaginary zeros.
      for (const c of [0, 1, 2, 7]) {
        const re = result.outputs.main[0].slice((c + 1) * size, (c + 2) * size), im = result.outputs.main[1].slice((c + 1) * size, (c + 2) * size);
        expect(Math.abs(im[0])).toBeLessThan(1e-6); expect(Math.abs(im[size / 2])).toBeLessThan(1e-6);
        for (let k = 1; k < size; k++) { expect(Math.abs(re[k] - re[size - k])).toBeLessThan(1e-6); expect(Math.abs(im[k] + im[size - k])).toBeLessThan(1e-6); }
      }
    }
  }, 60000);

  test(`larger internal FFT kernel matches f32-rounded direct DFT at ${rate}`, async () => {
    for (const size of [256]) {
      const cases = [
        [Float32Array.from({ length: size }, (_, n) => Number(n === 0)), new Float32Array(size)],
        [new Float32Array(size).fill(0.5), new Float32Array(size)],
        [Float32Array.from({ length: size }, (_, n) => n % 2 ? -0.5 : 0.5), new Float32Array(size)],
        ...[7, -13, 23.375].map(bin => [Float32Array.from({ length: size }, (_, n) => Math.cos(2 * Math.PI * bin * n / size) * 0.5), Float32Array.from({ length: size }, (_, n) => Math.sin(2 * Math.PI * bin * n / size) * 0.5)]),
      ];
      const frames = (cases.length + 1) * size, input = [new Float32Array(frames), new Float32Array(frames)];
      cases.forEach((value, n) => value.forEach((v, ch) => input[ch].set(v, n * size)));
      const result = await render(fftFixture(size), rate, input);
      expect(result.diagnostics.scrubbedSamples).toBe(0);
      for (let c = 0; c < cases.length; c++) for (const inverse of [false, true]) {
        const expected = directDft(cases[c][0], cases[c][1], inverse), start = (c + 1) * size;
        // Outputs are f32. Round the independent double DFT to that declared
        // format before comparing; this does not change the small-size oracle.
        for (let ch = 0; ch < 2; ch++) expect(maxError(result.outputs.main[(inverse ? 2 : 0) + ch].slice(start, start + size), Float32Array.from(expected[ch]))).toBeLessThan(1e-6);
      }
    }
  }, 60000);

  test(`STFT startup, all reset hop phases and exact N latency at ${rate}`, async () => {
    for (const size of [8, 16, 32, 64]) for (const hop of [size / 2, size / 4]) {
      const frames = 4096;
      const input = Float32Array.from({ length: frames }, (_, n) => n < frames - size ? (n % 137 === 0 ? 1 : 0.35 * Math.sin(n * 0.173) + 0.1 * Math.cos(n * 0.417)) : 0);
      const resets = new Float32Array(frames);
      for (let phase = 0; phase < hop; phase++) resets[128 + phase * (size + 1)] = 1;
      resets.fill(1, 3071, 3076); resets[3584] = 1;
      const p = stftFixture(size, hop), result = await render(p, rate, [input, resets]);
      const expected = directWola(input, resets, size, hop);
      expect(maxError(result.outputs.main[0], expected)).toBeLessThan(1.5e-7);
      let lastReset = -1;
      for (let n = 0; n < frames; n++) {
        if (resets[n]) lastReset = n;
        expect(Math.abs(result.outputs.main[0][n] - (n - size > lastReset ? input[n - size] : 0))).toBeLessThan(1.5e-7);
      }
      expect(result.diagnostics.scrubbedSamples).toBe(0);
      const first = await render(p, rate, [input.slice(0, 1024), resets.slice(0, 1024)]);
      const continuation = await render(p, rate, [input.slice(1024), resets.slice(1024)], first.state);
      expect(continuation.outputs.main[0]).toEqual(result.outputs.main[0].slice(1024));
    }
  }, 60000);
}

test('STFT preserves quiet f32 and high finite inputs; reset does not leak history', async () => {
  for (const amplitude of [2 ** -149, 2 ** -130, 1e-29, 1e-8, 2 ** 100, 3.4028234663852886e38]) {
    const input = new Float32Array(1024).fill(amplitude), resets = new Float32Array(1024); resets.fill(1, 511, 515);
    const result = await render(stftFixture(64, 16), 48000, [input, resets]);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
    const output = result.outputs.main[0];
    for (let n = 0; n < output.length; n++) {
      const expected = n < 64 || n >= 511 && n < 579 ? 0 : Math.fround(amplitude);
      expect(Number.isFinite(output[n])).toBe(true);
      expect(Math.abs(output[n] - expected)).toBeLessThanOrEqual(Math.abs(Math.fround(amplitude)) * 2e-7);
    }
  }
}, 60000);

test('STFT rejects unsupported sizes and window/hop combinations during capture', () => {
  for (const [size, hop] of [[0, 0], [7, 2], [12, 6], [128, 32], [16, 3], [16, 16], [NaN, 4]]) expect(() => stftFixture(size, hop)).toThrow(RangeError);
});
