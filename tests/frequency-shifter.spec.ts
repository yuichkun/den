import { test, expect } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, inspect, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { frequencyShifter, FREQUENCY_SHIFTER_LATENCY_SAMPLES } from '../src/frequency-shifter.js';
import { ports, reference, maxError, complexBin, carrierBins, multitone, kernel } from './frequency-shifter-consumer/reference.mjs';

const processor = defineProcessor(ctx => {
  const input = audioInput({ channels: 5, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
  const shifter = instantiate(frequencyShifter, { sampleRate: ctx.sampleRate }, { name: 'shift' });
  return { process() { forSample(i => output.ch(0).at(i).write(shifter.tick(input.ch(0).at(i), {
    shiftHz: input.ch(1).at(i), mix: input.ch(2).at(i), bypass: input.ch(3).at(i).gt(0), reset: input.ch(4).at(i).gt(0),
  }))); } };
});
async function render(rate: number, channels: Float32Array[], restore?: Uint8Array) {
  const result = await renderOffline(processor, { sampleRate: rate, duration: (channels[0].length - 0.25) / rate, inputs: { main: channels }, restore });
  expect(result.outputs.main[0].length).toBe(channels[0].length);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  expect(result.outputs.main[0].every(Number.isFinite)).toBe(true);
  return result;
}

test('frequency shifter rejects unsupported construction rates', () => {
  for (const sampleRate of [NaN, Infinity, -1, 0, 7999, 8000.5, 192001]) {
    expect(() => defineProcessor(() => { instantiate(frequencyShifter, { sampleRate }, { name: 'shift' }); return { process() {} }; })).toThrow(RangeError);
  }
  expect(FREQUENCY_SHIFTER_LATENCY_SAMPLES).toBe(31);
});

test('independent Hilbert transfer has bounded gain and quadrature error in the useful band', () => {
  let worstRejection = Infinity;
  for (let j = 0; j <= 4000; j++) {
    const omega = 2 * Math.PI * (0.05 + 0.4 * j / 4000);
    // Remove linear phase from the complex DTFT; ideal is exactly -i.
    let real = 0, imaginary = 0;
    kernel.forEach((tap: number, k: number) => { real += tap * Math.cos(omega * (k - 31)); imaginary -= tap * Math.sin(omega * (k - 31)); });
    expect(Math.abs(real)).toBeLessThan(1e-13);
    expect(Math.abs(imaginary + 1)).toBeLessThan(0.00035);
    const rejection = 20 * Math.log10(Math.abs((1 - imaginary) / (1 + imaginary)));
    worstRejection = Math.min(worstRejection, rejection);
  }
  expect(worstRejection).toBeGreaterThan(75);
});

for (const rate of [44100, 48000, 96000]) {
  test(`impulse, matched latency and signed modulation agree with independent convolution at ${rate}`, async () => {
    for (const shift of [0, rate / 32, -rate / 32]) {
      const channels = ports(rate, 512, { 0: (n: number) => n === 0 ? 1 : 0, 1: shift });
      const result = await render(rate, channels);
      expect(maxError(result.outputs.main[0], reference(rate, channels))).toBeLessThan(3e-8);
      if (shift === 0) {
        expect(result.outputs.main[0][31]).toBe(1);
        expect(result.outputs.main[0].filter(x => x !== 0).length).toBe(1);
      }
    }
  });

  test(`signed static shift preserves analytic phase and rejects image sidebands at ${rate}`, async () => {
    for (const sign of [-1, 1]) {
      const channels = ports(rate, 8192, { 0: multitone, 1: sign * rate / 32 });
      const result = await render(rate, channels), tail = result.outputs.main[0].slice(4096);
      for (const bin of carrierBins) {
        const desired = complexBin(tail, bin + sign * 128), image = complexBin(tail, bin - sign * 128);
        const phase = -2 * Math.PI * bin * 31 / 4096;
        expect(Math.hypot(desired.real - 0.15 * Math.cos(phase), desired.imaginary - 0.15 * Math.sin(phase))).toBeLessThan(3e-5);
        expect(20 * Math.log10(desired.magnitude / Math.max(image.magnitude, 1e-20))).toBeGreaterThan(70);
      }
    }
  });

  test(`sample automation, clamping, cross-zero, reset, bypass and exact snapshots at ${rate}`, async () => {
    const channels = ports(rate, 4096, {
      1: (n: number) => n < 512 ? rate / 73 : n < 768 ? 0 : n < 1536 ? -rate / 93 : n % 2 ? rate : -rate,
      2: (n: number) => n < 128 ? -1 : n < 256 ? 2 : (n % 89) / 88,
      3: (n: number) => n >= 700 && n < 1400 ? 1 : 0,
      4: (n: number) => n === 511 || n === 1537 || n >= 2047 && n <= 2052 ? 1 : 0,
    });
    const whole = await render(rate, channels);
    expect(maxError(whole.outputs.main[0], reference(rate, channels))).toBeLessThan(2e-7);
    const split = 1152, first = await render(rate, channels.map(a => a.slice(0, split)));
    const resumed = await render(rate, channels.map(a => a.slice(split)), first.state);
    expect(resumed.outputs.main[0]).toEqual(whole.outputs.main[0].slice(split));
    const cleared = await render(rate, ports(rate, 256, { 0: 0, 4: (n: number) => n === 0 ? 1 : 0 }), first.state);
    expect(cleared.outputs.main[0].every(x => x === 0)).toBe(true);
  });

  test(`zero-Hz holds accumulated phase, bypass stays delayed, and tiny input survives at ${rate}`, async () => {
    const channels = ports(rate, 1024, { 1: (n: number) => n < 128 ? rate / 512 : 0 });
    const result = await render(rate, channels);
    expect(maxError(result.outputs.main[0], reference(rate, channels))).toBeLessThan(2e-7);
    const dry = Float32Array.from(channels[0], (_, n) => n >= 31 ? channels[0][n - 31] : 0);
    expect(maxError(result.outputs.main[0].slice(256), dry.slice(256))).toBeGreaterThan(0.5);
    for (const value of [2 ** -149, 2 ** -126, 1e-31, 1, -1]) {
      const tiny = await render(rate, ports(rate, 128, { 0: value, 1: 0 }));
      expect(tiny.outputs.main[0].slice(0, 31).every(x => x === 0)).toBe(true);
      expect(tiny.outputs.main[0].slice(31).every(x => x === Math.fround(value))).toBe(true);
    }
    for (const sign of [-1, 1]) {
      const shifted = await render(rate, ports(rate, 128, { 1: sign * 2 ** -149 }));
      const value = Number(inspect(shifted.state).slots['shift/phaseScaled'].value);
      expect(Math.abs(value / (sign * 2 ** -149 / rate * 128 * 2 ** 128) - 1)).toBeLessThan(1e-12);
    }
    const bypass = await render(rate, ports(rate, 512, { 3: 1 }));
    const input = ports(rate, 512)[0];
    expect(bypass.outputs.main[0]).toEqual(Float32Array.from(input, (_, n) => n < 31 ? 0 : input[n - 31]));
    const headroom = await render(rate, ports(rate, 128, { 0: (n: number) => n >= 1 && n <= 63 ? Math.sign(kernel[63 - n]) : 0, 1: rate / 4 }));
    expect(headroom.outputs.main[0][63]).toBeGreaterThan(2.34);
    expect(Math.max(...headroom.outputs.main[0].map(Math.abs))).toBeLessThan(3.346);
  });

  test(`out-of-band inputs expose images and translated Nyquist crossing folds at ${rate}`, async () => {
    const length = 4096;
    const dc = await render(rate, ports(rate, 8192, { 0: 0.5, 1: rate / 32 }));
    expect(complexBin(dc.outputs.main[0].slice(length), 128).magnitude).toBeCloseTo(0.5, 6);
    const nearDc = await render(rate, ports(rate, 8192, { 0: (n: number) => 0.5 * Math.cos(2 * Math.PI * 32 * n / length), 1: rate / 32 }));
    const lowTail = nearDc.outputs.main[0].slice(length);
    expect(complexBin(lowTail, 96).magnitude).toBeGreaterThan(0.1);
    const alias = await render(rate, ports(rate, 8192, { 0: (n: number) => 0.5 * Math.cos(2 * Math.PI * 1792 * n / length), 1: rate / 8 }));
    expect(complexBin(alias.outputs.main[0].slice(length), 1792).magnitude).toBeGreaterThan(0.499);
    expect(maxError(alias.outputs.main[0], reference(rate, ports(rate, 8192, { 0: (n: number) => 0.5 * Math.cos(2 * Math.PI * 1792 * n / length), 1: rate / 8 })))).toBeLessThan(2e-7);
    const reflected = await render(rate, ports(rate, 8192, { 0: (n: number) => 0.5 * Math.cos(2 * Math.PI * 512 * n / length), 1: -rate / 4 }));
    const folded = complexBin(reflected.outputs.main[0].slice(length), 512), phase = 2 * Math.PI * 512 * 31 / length;
    expect(Math.hypot(folded.real - 0.5 * Math.cos(phase), folded.imaginary - 0.5 * Math.sin(phase))).toBeLessThan(3e-5);
  });
}
