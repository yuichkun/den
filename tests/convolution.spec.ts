import { expect, test } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate, type CompiledProcessor } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { partitionedConvolution } from '../src/convolution.js';

function fixture(blockSize: number, impulse: readonly number[]) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 2, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
    const convolution = instantiate(partitionedConvolution, { blockSize, impulse }, { name: 'convolution' });
    return { process() { forSample((i, everyNSamples) => {
      output.ch(0).at(i).write(convolution.tick(input.ch(0).at(i), input.ch(1).at(i).gt(0), everyNSamples));
    }); } };
  });
}
const render = (p: CompiledProcessor, rate: number, input: Float32Array, reset = new Float32Array(input.length), restore?: Uint8Array) =>
  renderOffline(p, { sampleRate: rate, duration: (input.length - 0.25) / rate, inputs: { main: [input, reset] }, restore });
// Independent direct FIR with absolute sample indices. No FFT, partition,
// overlap-add buffers or spectral-delay-line recurrence from the implementation.
function direct(input: Float32Array, reset: Float32Array, taps: readonly number[], latency: number) {
  const result = new Float64Array(input.length); let start = 0;
  for (let n = 0; n < input.length; n++) {
    if (reset[n]) start = n + 1;
    for (let k = 0; k < taps.length; k++) if (n - latency - k >= start) result[n] += input[n - latency - k] * taps[k];
  }
  return result;
}
function error(actual: ArrayLike<number>, expected: ArrayLike<number>) {
  let maximum = 0; for (let n = 0; n < actual.length; n++) maximum = Math.max(maximum, Math.abs(actual[n] - expected[n])); return maximum;
}

for (const rate of [44100, 48000, 96000]) {
  test(`uniform FFT convolution matches direct FIR at partition/reset boundaries at ${rate}`, async () => {
    for (const block of [4, 8, 16, 32]) {
      const frames = 4096;
      const input = Float32Array.from({ length: frames }, (_, n) => n < frames - 5 * block ? 0.35 * Math.sin(n * 0.731) + 0.2 * Math.cos(n * 0.37) : 0);
      input[0] = 1; input[block - 1] = -1; input[block] = 0.8; input[127] = 1; input[128] = -0.5;
      const reset = new Float32Array(frames);
      for (let phase = 0; phase < block; phase++) reset[512 + phase * (block + 1)] = 1;
      reset.fill(1, 3071, 3076); reset[3584] = 1;
      const irs = [
        [1],
        Array.from({ length: block + 1 }, (_, n) => n === 0 ? 0.5 : n === block - 1 ? -0.25 : n === block ? 0.75 : 0),
        Array.from({ length: 2 * block + 3 }, (_, n) => Math.sin(n * 0.51 + 0.25) / (3 * block)),
        Array.from({ length: 4 * block }, (_, n) => n % block === block - 1 ? (n % 2 ? -0.5 : 0.5) : 0),
      ];
      for (const taps of irs) {
        const result = await render(fixture(block, taps), rate, input, reset);
        expect(error(result.outputs.main[0], direct(input, reset, taps, block))).toBeLessThan(3e-7);
        expect(result.diagnostics.scrubbedSamples).toBe(0);
        expect(result.outputs.main[0].every(Number.isFinite)).toBe(true);
      }
    }
  }, 60000);

  test(`convolution impulse, linearity and snapshot continuation at ${rate}`, async () => {
    const block = 32, frames = 2048;
    const taps = Array.from({ length: 113 }, (_, n) => n === 0 ? 0.5 : n === 31 ? -0.25 : n === 32 ? 0.75 : n === 63 ? 0.5 : n === 64 ? -0.5 : n === 112 ? 0.25 : 0);
    const p = fixture(block, taps), impulse = new Float32Array(frames); impulse[0] = 1;
    const impulseOut = await render(p, rate, impulse);
    for (let n = 0; n < frames; n++) expect(Math.abs(impulseOut.outputs.main[0][n] - (taps[n - block] ?? 0))).toBeLessThan(1e-7);
    const a = Float32Array.from({ length: frames }, (_, n) => Math.sin(n * 0.713) * 0.25);
    const b = Float32Array.from({ length: frames }, (_, n) => Math.cos(n * 0.315) * 0.25);
    const sum = Float32Array.from(a, (value, n) => value + b[n]);
    const ar = await render(p, rate, a), br = await render(p, rate, b), together = await render(p, rate, sum);
    for (let n = 0; n < frames; n++) expect(Math.abs(together.outputs.main[0][n] - ar.outputs.main[0][n] - br.outputs.main[0][n])).toBeLessThan(1.5e-7);
    const first = await render(p, rate, sum.slice(0, 640));
    const continued = await render(p, rate, sum.slice(640), undefined, first.state);
    expect(continued.outputs.main[0]).toEqual(together.outputs.main[0].slice(640));
    for (const result of [impulseOut, ar, br, together, first, continued]) expect(result.diagnostics.scrubbedSamples).toBe(0);
  }, 60000);
}

test('zero IR and f32 subnormal signals follow the analytical gain without a hidden gate', async () => {
  for (const amplitude of [2 ** -149, 2 ** -130, 1e-29, 0.5, 1]) {
    const input = new Float32Array(512).fill(amplitude);
    const silent = await render(fixture(8, [0, 0, 0, 0]), 48000, input);
    expect(silent.outputs.main[0].every(x => x === 0)).toBe(true);
    const through = await render(fixture(8, [1]), 48000, input);
    for (let n = 8; n < input.length; n++) expect(through.outputs.main[0][n]).toBe(Math.fround(amplitude));
    expect(through.diagnostics.scrubbedSamples).toBe(0);
  }
  const gain = await render(fixture(4, [1, 1, 1, 1]), 48000, new Float32Array(512).fill(1));
  expect(gain.outputs.main[0].slice(8).every(x => x === 4)).toBe(true);
  expect(gain.diagnostics.scrubbedSamples).toBe(0);
}, 60000);

test('construction rejects invalid block/IR capacity, nonfinite coefficients and gain bounds', () => {
  for (const block of [0, 3, 12, 64, NaN]) expect(() => fixture(block, [1])).toThrow(RangeError);
  for (const taps of [[], new Array(3), new Array(17).fill(0), [NaN], [Infinity], [1.01], [1, 1, 1, 1, 0.01]]) expect(() => fixture(4, taps)).toThrow(RangeError);
});
