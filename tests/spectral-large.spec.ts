import { expect, test } from 'vitest';
import { audioInput, audioOutput, defineProcessor, f32, f64, forSample, instantiate, state } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { spectralFft, spectralForEach } from '../src/spectral-fft.js';

// Independent direct DFT. No radix permutation, butterfly or twiddle recurrence.
function dft(real: Float32Array, imag: Float32Array, inverse: boolean) {
  const size = real.length, sign = inverse ? 1 : -1;
  const output = [new Float32Array(size), new Float32Array(size)];
  for (let k = 0; k < size; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < size; n++) {
      const angle = sign * 2 * Math.PI * k * n / size;
      re += real[n] * Math.cos(angle) - imag[n] * Math.sin(angle);
      im += real[n] * Math.sin(angle) + imag[n] * Math.cos(angle);
    }
    output[0][k] = re / (inverse ? size : 1);
    output[1][k] = im / (inverse ? size : 1);
  }
  return output;
}
function fixture(size: number) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 2, name: 'main' }), output = audioOutput({ channels: 4, name: 'main' });
    const history = [state.buffer.f64({ size }), state.buffer.f64({ size })];
    const bins = Array.from({ length: 4 }, () => state.buffer.f64({ size }));
    const cursor = state.i32(0);
    const fft = instantiate(spectralFft, { size }, { name: 'fft' });
    return { process() { forSample((i, everyNSamples) => {
      everyNSamples(size, () => {
        for (const inverse of [false, true]) {
          const result = fft.transform(n => history[0].read(n), n => history[1].read(n), inverse);
          spectralForEach(size, k => {
            bins[inverse ? 2 : 0].write(k, result.real(k));
            bins[inverse ? 3 : 1].write(k, result.imag(k));
          });
        }
      });
      for (let ch = 0; ch < 4; ch++) output.ch(ch).at(i).write(f32(bins[ch].read(cursor.read())));
      for (let ch = 0; ch < 2; ch++) history[ch].write(cursor.read(), f64(input.ch(ch).at(i)));
      cursor.write(cursor.read().add(1).mod(size));
    }); } };
  });
}

for (const rate of [44100, 48000, 96000]) test(`N1024 internal kernel sign/layout/normalization versus direct DFT at ${rate}`, async () => {
  const size = 1024;
  let seed = 149;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
  const cases = [
    [Float32Array.from({ length: size }, (_, n) => Number(n === 0)), new Float32Array(size)],
    [new Float32Array(size).fill(0.5), new Float32Array(size)],
    [Float32Array.from({ length: size }, (_, n) => n % 2 ? -0.5 : 0.5), new Float32Array(size)],
    ...[7, -13, 23.375].map(bin => [Float32Array.from({ length: size }, (_, n) => Math.cos(2 * Math.PI * bin * n / size) * 0.5), Float32Array.from({ length: size }, (_, n) => Math.sin(2 * Math.PI * bin * n / size) * 0.5)]),
    [Float32Array.from({ length: size }, random), Float32Array.from({ length: size }, random)],
    [Float32Array.from({ length: size }, random), new Float32Array(size)],
  ];
  const frames = (cases.length + 1) * size, input = [new Float32Array(frames), new Float32Array(frames)];
  cases.forEach((value, n) => value.forEach((v, ch) => input[ch].set(v, n * size)));
  const result = await renderOffline(fixture(size), { sampleRate: rate, duration: (frames - 0.25) / rate, inputs: { main: input } });
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  let maxError = 0;
  for (let c = 0; c < cases.length; c++) for (const inverse of [false, true]) {
    const expected = dft(cases[c][0], cases[c][1], inverse), start = (c + 1) * size;
    for (let ch = 0; ch < 2; ch++) for (let k = 0; k < size; k++) maxError = Math.max(maxError, Math.abs(result.outputs.main[(inverse ? 2 : 0) + ch][start + k] - expected[ch][k]));
  }
  expect(maxError).toBeLessThan(1e-6);
  for (const c of [0, 1, 2, 7]) {
    const re = result.outputs.main[0].slice((c + 1) * size, (c + 2) * size), im = result.outputs.main[1].slice((c + 1) * size, (c + 2) * size);
    for (let k = 1; k < size; k++) { expect(Math.abs(re[k] - re[size - k])).toBeLessThan(1e-6); expect(Math.abs(im[k] + im[size - k])).toBeLessThan(1e-6); }
    expect(Math.abs(im[0])).toBeLessThan(1e-6); expect(Math.abs(im[size / 2])).toBeLessThan(1e-6);
  }
  console.log(JSON.stringify({ size, sampleRate: rate, complexCases: cases.length, forwardAndInverse: true, maxF32RoundedDftError: maxError, scrubbedSamples: 0, status: 'CANDIDATE internal kernel only' }));
}, 60000);
