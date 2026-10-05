import { expect, test } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate, type CompiledProcessor } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { spectralGate } from '../src/spectral-gate.js';
import { stftIdentity } from '../src/spectral.js';
import { directGateWola, gateFrame, maxError } from './spectral-gate-consumer/oracle.mjs';

function fixture(size: number, hopSize: number, identity = false) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 4, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
    if (identity) {
      const stft = instantiate(stftIdentity, { size, hopSize }, { name: 'unit' });
      return { process() { forSample((i, everyNSamples) => output.ch(0).at(i).write(stft.tick(input.ch(0).at(i), input.ch(1).at(i).gt(0), everyNSamples))); } };
    }
    const gate = instantiate(spectralGate, { size, hopSize }, { name: 'unit' });
    return { process() { forSample((i, everyNSamples) => output.ch(0).at(i).write(gate.tick(input.ch(0).at(i), input.ch(2).at(i), input.ch(3).at(i), input.ch(1).at(i).gt(0), everyNSamples))); } };
  });
}
const render = (p: CompiledProcessor, rate: number, inputs: Float32Array[], restore?: Uint8Array) =>
  renderOffline(p, { sampleRate: rate, duration: (inputs[0].length - 0.25) / rate, inputs: { main: inputs }, restore });
const data = (size: number, count: number) => [
  Float32Array.from({ length: count }, (_, n) => n < count - size ? 0.45 * Math.sin(2 * Math.PI * 3.375 * n / size) + 0.2 * Math.cos(2 * Math.PI * 7 * n / size) + (n % 137 === 0 ? 0.3 : 0) : 0),
  new Float32Array(count), new Float32Array(count).fill(0.18), new Float32Array(count).fill(0.125),
];

for (const rate of [44100, 48000, 96000]) {
  test(`spectral gate matches independent DFT/WOLA with all reset phases and sampled edits at ${rate}`, async () => {
    for (const size of [8, 16, 64]) for (const hop of [size / 2, size / 4]) {
      const count = Math.ceil((hop * (size + hop + 1) + 5 * size) / 128) * 128, input = data(size, count);
      for (let phase = 0; phase < hop; phase++) input[1][2 * size + phase * (size + hop + 1)] = 1;
      input[1].fill(1, 127, 131);
      for (let n = 0; n < count; n++) {
        input[2][n] = [0.06, 0.24, 0.49, 0.001, 0.9][Math.floor(n / (hop - 1)) % 5];
        input[3][n] = [-1, 0, 0.1, 0.7, 2][Math.floor(n / (hop + 1)) % 5];
      }
      const result = await render(fixture(size, hop), rate, input);
      expect(maxError(result.outputs.main[0], directGateWola(...input, size, hop))).toBeLessThan(2e-7);
      expect(result.outputs.main[0].every(Number.isFinite)).toBe(true);
      expect(result.diagnostics.scrubbedSamples).toBe(0);
    }
  }, 60000);

  test(`large spectral gate DFT oracle, frame edits and all quantum snapshot phases at ${rate}`, async () => {
    for (const hop of [256, 512]) {
      const size = 1024, input = data(size, 8192);
      input[1][1023] = 1; input[1][2177] = 1; input[1].fill(1, 4095, 4099);
      for (const n of [127, 128, 129, 255, 256, 257, 511, 512, 513, 2047, 2048, 2049, 5120, 5248]) {
        input[2].fill(n % 2 ? 0.5 : 0.025, n); input[3].fill(n % 3 ? 0.05 : 0.5, n);
      }
      const p = fixture(size, hop), whole = await render(p, rate, input);
      expect(maxError(whole.outputs.main[0], directGateWola(...input, size, hop))).toBeLessThan(2e-7);
      for (const offset of [128, 256, 384, 512]) {
        const split = 4096 + offset, first = await render(p, rate, input.map(x => x.slice(0, split)));
        const resumed = await render(p, rate, input.map(x => x.slice(split)), first.state);
        expect(resumed.outputs.main[0]).toEqual(whole.outputs.main[0].slice(split));
        expect(resumed.state).toEqual(whole.state);
        expect(resumed.diagnostics.scrubbedSamples).toBe(0);
      }
      expect(whole.diagnostics.scrubbedSamples).toBe(0);
    }
  }, 60000);

  test(`threshold0/floor1, tiny inputs and normalized extrema retain exact identity PCM at ${rate}`, async () => {
    for (const [size, hop] of [[8, 2], [64, 32], [1024, 512]]) {
      const p = fixture(size, hop), identity = fixture(size, hop, true);
      for (const amplitude of [2 ** -149, 2 ** -130, 1e-29, 1]) {
        const input = data(size, 4 * Math.max(128, size));
        input[0] = Float32Array.from(input[0], (_, n) => (n % 3 ? 1 : -1) * amplitude);
        input[1][127] = 1; input[1].fill(1, 255, 259);
        const reference = await render(identity, rate, input);
        for (const [threshold, floor] of [[0, 0], [-1, 0.1], [1, 1], [Infinity, Infinity], [NaN, 0], [Infinity, NaN], [-Infinity, -Infinity]]) {
          input[2].fill(threshold); input[3].fill(floor);
          const result = await render(p, rate, input);
          expect(result.outputs.main[0]).toEqual(reference.outputs.main[0]);
          expect(result.diagnostics.scrubbedSamples).toBe(0);
        }
      }
    }
  }, 60000);
}

test('DC/Nyquist/on-bin/off-bin calibrated threshold decisions and explicit conjugate symmetry', async () => {
  const size = 64, hop = 16, length = 1024;
  for (const bin of [0, 4, 4.375, size / 2]) {
    const input = data(size, length);
    input[0] = Float32Array.from({ length }, (_, n) => 0.5 * Math.cos(2 * Math.PI * bin * n / size));
    const frame = Float64Array.from({ length: size }, (_, n) => input[0][n] * Math.sin(Math.PI * n / size));
    for (const threshold of [0.24, 0.499, 0.501, 0.76, 2]) {
      input[2].fill(threshold); input[3].fill(0);
      const result = await render(fixture(size, hop), 48000, input), expected = directGateWola(...input, size, hop);
      expect(maxError(result.outputs.main[0], expected)).toBeLessThan(1e-7);
      const oracle = gateFrame(frame, threshold, 0);
      for (let k = 1; k < size / 2; k++) {
        expect(oracle.spectrum[0][k]).toBe(oracle.spectrum[0][size - k]);
        expect(oracle.spectrum[1][k]).toBe(-oracle.spectrum[1][size - k]);
      }
      expect(oracle.spectrum[1][0]).toBe(0); expect(oracle.spectrum[1][size / 2]).toBe(0);
      if (bin === 0 || bin === size / 2) expect(oracle.gains[bin]).toBe(threshold < 0.5 ? 1 : 0);
    }
  }
}, 60000);

for (const rate of [44100, 48000, 96000]) test(`quiet threshold/floor controls survive scaled storage and active gating at ${rate}`, async () => {
  const size = 64, hop = 16, p = fixture(size, hop);
  for (const amplitude of [2 ** -149, 2 ** -130, 1e-29, 1e-8, 1]) for (const floor of [0, 2 ** -149, 1e-29, 0.25]) {
    const input = data(size, 1024); input[0].fill(amplitude); input[2].fill(Math.fround(amplitude * 2)); input[3].fill(floor);
    const result = await render(p, rate, input), expected = directGateWola(...input, size, hop);
    expect(maxError(result.outputs.main[0], Float32Array.from(expected))).toBeLessThanOrEqual(Math.max(2 ** -149, amplitude * 1e-7));
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
}, 60000);

test('controls are sampled at frame t; between-frame edits cannot affect output', async () => {
  const size = 64, hop = 16, a = data(size, 2048), b = a.map(x => x.slice());
  for (let n = 0; n < b[0].length; n++) if (n % hop !== 0) { b[2][n] = n % 2 ? Infinity : 0; b[3][n] = n % 2 ? 1 : 0; }
  const p = fixture(size, hop), x = await render(p, 48000, a), y = await render(p, 48000, b);
  expect(y.outputs.main[0]).toEqual(x.outputs.main[0]);
  // Change exactly at a committed frame while leaving neighboring samples alone.
  b[2][1024] = 2;
  const edited = await render(p, 48000, b);
  expect(maxError(edited.outputs.main[0], directGateWola(...b, size, hop))).toBeLessThan(1e-7);
  expect(edited.outputs.main[0]).not.toEqual(x.outputs.main[0]);
});

for (const rate of [44100, 48000, 96000]) test(`transient support and normalized-extreme headroom at ${rate}`, async () => {
  const size = 64, hop = 16, count = 1024, input = data(size, count), p = fixture(size, hop);
  input[0].fill(0); input[0][257] = 1; input[2].fill(0.035); input[3].fill(0);
  const result = await render(p, rate, input), expected = directGateWola(...input, size, hop);
  expect(maxError(result.outputs.main[0], expected)).toBeLessThan(1e-7);
  const support = Array.from(result.outputs.main[0]).flatMap((x, n) => Math.abs(x) > 1e-6 ? [n] : []);
  expect(support[0]).toBeLessThan(257 + size); expect(support.at(-1)).toBeGreaterThan(257 + size);
  expect(support[0]).toBeGreaterThan(257); expect(support.at(-1)).toBeLessThan(257 + 2 * size);
  // A clipped low-frequency square wave has harmonics of alternating sign;
  // selecting stronger bins can generate peaks above the original unit peak.
  input[0] = Float32Array.from({ length: count }, (_, n) => Math.sign(Math.sin(2 * Math.PI * 3 * n / size)));
  input[2].fill(0.45);
  const square = await render(p, rate, input), peak = Math.max(...square.outputs.main[0].map(Math.abs));
  expect(peak).toBeGreaterThan(1.01); expect(peak).toBeLessThan(2 * Math.sqrt(size));
  expect(square.diagnostics.scrubbedSamples).toBe(0);
});

test('unsupported gate capacities fail during construction', () => {
  for (const [size, hop] of [[0, 0], [7, 2], [12, 6], [2048, 512], [16, 3], [16, 16], [NaN, 4]]) expect(() => fixture(size, hop)).toThrow(RangeError);
});

for (const rate of [44100, 48000, 96000]) test(`gate attenuates weak bins while retaining a strong partial at ${rate}`, async () => {
  const size = 64, hop = 16, count = 4096, input = data(size, count);
  input[0] = Float32Array.from({ length: count }, (_, n) => 0.5 * Math.cos(2 * Math.PI * 6 * n / size) + 0.04 * Math.cos(2 * Math.PI * 18 * n / size));
  input[2].fill(0.1); input[3].fill(0);
  const result = await render(fixture(size, hop), rate, input), output = result.outputs.main[0];
  const amplitude = (bin: number) => {
    let re = 0, im = 0;
    for (let n = 2 * size; n < count; n++) { const angle = 2 * Math.PI * bin * n / size; re += output[n] * Math.cos(angle); im -= output[n] * Math.sin(angle); }
    return 2 * Math.hypot(re, im) / (count - 2 * size);
  };
  expect(amplitude(6)).toBeGreaterThan(0.35); expect(amplitude(6)).toBeLessThan(0.55);
  expect(amplitude(18)).toBeLessThan(0.01);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
});

for (const rate of [44100, 48000, 96000]) test(`processed tail needs more than N zeros and fully drains within2N at ${rate}`, async () => {
  const size = 64, hop = 16, sourceLength = 128, count = 384;
  const input = data(size, count); input[0].fill(0); input[0][sourceLength - 1] = 1;
  input[2].fill(0.035); input[3].fill(0);
  const result = await render(fixture(size, hop), rate, input), output = result.outputs.main[0];
  expect(maxError(output, directGateWola(...input, size, hop))).toBeLessThan(1e-7);
  const oldCutoff = sourceLength + size, completeCutoff = sourceLength + 2 * size;
  const truncatedTail = output.slice(oldCutoff, completeCutoff);
  expect(Math.max(...truncatedTail.map(Math.abs))).toBeGreaterThan(0.02);
  const nonzero = Array.from(output).flatMap((value, sample) => value !== 0 ? [sample] : []);
  expect(nonzero.at(-1)).toBe(223);
  expect(output.slice(completeCutoff).every(value => value === 0)).toBe(true);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
});
