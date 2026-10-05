import { expect, test } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate, type CompiledProcessor } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { spectralFreeze } from '../src/spectral-freeze.js';
import { stftIdentity } from '../src/spectral.js';
import { directDft, directFreezeWola, maxError, rotateSpectrum } from './spectral-freeze-consumer/oracle.mjs';

function fixture(size: number, hopSize: number, identity = false) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 3, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
    if (identity) {
      const unit = instantiate(stftIdentity, { size, hopSize }, { name: 'unit' });
      return { process() { forSample((i, everyNSamples) => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), input.ch(1).at(i).gt(0), everyNSamples))); } };
    }
    const unit = instantiate(spectralFreeze, { size, hopSize }, { name: 'unit' });
    return { process() { forSample((i, everyNSamples) => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), input.ch(2).at(i).gt(0), input.ch(1).at(i).gt(0), everyNSamples))); } };
  });
}
const render = (p: CompiledProcessor, rate: number, inputs: Float32Array[], restore?: Uint8Array) =>
  renderOffline(p, { sampleRate: rate, duration: (inputs[0].length - 0.25) / rate, inputs: { main: inputs }, restore });
const data = (size: number, count: number) => [
  Float32Array.from({ length: count }, (_, n) => 0.42 * Math.sin(2 * Math.PI * 3.375 * n / size) + 0.2 * Math.cos(2 * Math.PI * 7 * n / size) + (n % 137 === 0 ? 0.3 : 0)),
  new Float32Array(count), new Float32Array(count),
];

for (const rate of [44100, 48000, 96000]) {
  test(`freeze matches independent dense DFT/WOLA through every small reset phase at ${rate}`, async () => {
    for (const size of [8, 16, 64]) for (const hop of [size / 2, size / 4]) {
      const count = Math.ceil((hop * (size + hop + 1) + 6 * size) / 128) * 128, input = data(size, count);
      input[2].fill(1);
      for (let phase = 0; phase < hop; phase++) input[1][2 * size + phase * (size + hop + 1)] = 1;
      input[1].fill(1, 127, 131);
      for (let t = 4 * size; t < count; t += 7 * hop + 1) input[2].fill(0, t, t + hop + 2);
      const result = await render(fixture(size, hop), rate, input);
      expect(maxError(result.outputs.main[0], directFreezeWola(...input, size, hop))).toBeLessThan(2e-7);
      expect(maxError(result.outputs.main[0], directFreezeWola(...input, size, hop, 'shift'))).toBeLessThan(2e-7);
      expect(result.diagnostics.scrubbedSamples).toBe(0);
    }
  }, 60000);

  test(`large freeze DFT, eager noncommitting hooks and all snapshot phase classes at ${rate}`, async () => {
    for (const hop of [256, 512]) {
      const size = 1024, count = 12288, input = data(size, count), p = fixture(size, hop);
      input[2].fill(1, 2048, 7681); input[2].fill(1, 8703, 11265);
      input[1][1023] = 1; input[1][4225] = 1; input[1].fill(1, 6143, 6147);
      // Pulse only at eager, uncommitted FFT calls: cannot cause capture/release.
      for (let t = 128; t < count; t += 128) if (t % hop) input[2][t] = input[2][t] ? 0 : 1;
      const whole = await render(p, rate, input), expected = directFreezeWola(...input, size, hop);
      expect(maxError(whole.outputs.main[0], expected)).toBeLessThan(2e-7);
      for (const base of [2048, 4096, 6144, 8192]) for (let offset = 128; offset <= hop; offset += 128) {
        const split = base + offset, first = await render(p, rate, input.map(x => x.slice(0, split)));
        const resumed = await render(p, rate, input.map(x => x.slice(split)), first.state);
        expect(resumed.outputs.main[0]).toEqual(whole.outputs.main[0].slice(split));
        expect(resumed.state).toEqual(whole.state); expect(resumed.diagnostics.scrubbedSamples).toBe(0);
      }
      expect(whole.diagnostics.scrubbedSamples).toBe(0);
    }
  }, 60000);

  test(`freeze false exactly preserves identity PCM including reset and tiny samples at ${rate}`, async () => {
    for (const [size, hop] of [[8, 2], [64, 32], [256, 64], [512, 256], [1024, 256], [1024, 512]]) {
      const input = data(size, 4 * Math.max(128, size));
      input[0] = Float32Array.from(input[0], (_, n) => [2 ** -149, 2 ** -130, 1e-29, -1, 0.5, 1][n % 6]);
      input[1][127] = 1; input[1].fill(1, 255, 259);
      const actual = await render(fixture(size, hop), rate, input), expected = await render(fixture(size, hop, true), rate, input);
      expect(actual.outputs.main[0]).toEqual(expected.outputs.main[0]); expect(actual.diagnostics.scrubbedSamples).toBe(0);
    }
  }, 60000);

  test(`DC, Nyquist, on-bin/off-bin capture and positive phase progression at ${rate}`, async () => {
    const size = 64, hop = 16, count = 2048, capture = 256;
    for (const bin of [0, 3, 3.375, 32]) {
      const input = data(size, count);
      input[0] = Float32Array.from(input[0], (_, n) => 0.75 * Math.cos(2 * Math.PI * bin * n / size + 0.31)); input[2].fill(1, capture);
      const actual = await render(fixture(size, hop), rate, input), expected = directFreezeWola(...input, size, hop);
      expect(maxError(actual.outputs.main[0], expected)).toBeLessThan(2e-7);
      const frame = Float64Array.from({ length: size }, (_, n) => input[0][capture - size + n] * Math.sin(Math.PI * n / size));
      const spectrum = directDft(frame, new Float64Array(size));
      for (let step = 0; step < 4; step++) {
        const shifted = directDft(...rotateSpectrum(spectrum, step, hop), true);
        expect(maxError(shifted[0], Float64Array.from(frame, (_, n) => frame[(n + step * hop) % size]))).toBeLessThan(1e-12);
        expect(Math.max(...shifted[1].map(Math.abs))).toBeLessThan(1e-12);
      }
      // Held output is N-periodic, including an off-bin source that is not.
      expect(maxError(actual.outputs.main[0].slice(capture + 2 * size, -size), actual.outputs.main[0].slice(capture + 3 * size))).toBe(0);
      if (bin === 3) {
        // A negative rotation is a right shift and has observably wrong phase.
        const positive = directDft(...rotateSpectrum(spectrum, 1, hop), true)[0];
        const negative = directDft(...rotateSpectrum(spectrum, -1, hop), true)[0];
        expect(maxError(positive, negative)).toBeGreaterThan(0.5);
      }
      if (bin === 3.375) expect(maxError(actual.outputs.main[0].slice(capture + size), input[0].slice(capture, -size))).toBeGreaterThan(0.1);
      expect(actual.diagnostics.scrubbedSamples).toBe(0);
    }
  }, 60000);

  test(`capture excludes current input; between-frame edits cannot change hold at ${rate}`, async () => {
    const size = 64, hop = 16, input = data(size, 2048), p = fixture(size, hop), other = input.map(x => x.slice());
    input[2].fill(1, 256, 1280); other[2].set(input[2]);
    for (let n = 0; n < input[0].length; n++) if (n % hop) other[2][n] = other[2][n] ? 0 : 1;
    other[0][256] = -0.99;
    const a = await render(p, rate, input), b = await render(p, rate, other);
    expect(b.outputs.main[0].slice(0, 1280)).toEqual(a.outputs.main[0].slice(0, 1280));
    expect(maxError(b.outputs.main[0], directFreezeWola(...other, size, hop))).toBeLessThan(2e-7);
    // A low pulse on a committed frame releases, even if high on neighbors.
    other[2][512] = 0;
    const released = await render(p, rate, other);
    expect(released.outputs.main[0]).not.toEqual(a.outputs.main[0]);
    expect(maxError(released.outputs.main[0], directFreezeWola(...other, size, hop))).toBeLessThan(2e-7);
  });

  test(`frozen tiny signals, normalized extrema, reset silence and complete release drain at ${rate}`, async () => {
    const size = 64, hop = 16, count = 4096, p = fixture(size, hop);
    for (const amplitude of [2 ** -149, 2 ** -130, 1e-29, 1]) {
      const input = data(size, count); input[0] = Float32Array.from(input[0], (_, n) => (n % 3 ? 1 : -1) * amplitude);
      input[2].fill(1, 256, 2049); input[0].fill(0, 1536);
      const result = await render(p, rate, input), expected = Float32Array.from(directFreezeWola(...input, size, hop, 'shift'));
      expect(maxError(result.outputs.main[0], expected)).toBeLessThanOrEqual(Math.max(2 ** -149, amplitude * 2e-7));
      expect(Math.max(...result.outputs.main[0].slice(1600, 2048).map(Math.abs))).toBeGreaterThan(0);
      expect(result.outputs.main[0].slice(2049 + 2 * size).every(x => x === 0)).toBe(true);
      expect(Math.max(...result.outputs.main[0].map(Math.abs))).toBeLessThanOrEqual(2 * Math.sqrt(size) * amplitude);
      expect(result.diagnostics.scrubbedSamples).toBe(0);
    }
    const held = data(size, count); held[2].fill(1, 256); held[1].fill(1, 777, 1027);
    const reset = await render(p, rate, held);
    expect(reset.outputs.main[0].slice(777, 1040).every(x => x === 0)).toBe(true);
    expect(maxError(reset.outputs.main[0], directFreezeWola(...held, size, hop))).toBeLessThan(2e-7);
  }, 60000);
}

test('unsupported freeze capacities fail during construction', () => {
  for (const [size, hop] of [[0, 0], [7, 2], [12, 6], [2048, 512], [16, 3], [16, 16], [NaN, 4]]) expect(() => fixture(size, hop)).toThrow(RangeError);
});
