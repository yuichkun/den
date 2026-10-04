import { test, expect } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate, f32, bool } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { lfo, modulatePitch, modulateCutoff, modulateDelay } from '../src/lfo.js';

const rates = [44100, 48000, 96000];
const close = (actual: Float32Array, expected: number[], tolerance = 2e-6) => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, n) => { expect(Number.isFinite(v)).toBe(true); expect(Math.abs(v - expected[n]), `sample ${n}: ${v} vs ${expected[n]}`).toBeLessThan(tolerance); });
};
const fixture = (sampleRate: number) => defineProcessor(() => {
  const input = audioInput({ channels: 3, name: 'controls' });
  const output = audioOutput({ channels: 2, name: 'main' });
  const a = instantiate(lfo, { sampleRate }, { name: 'a' });
  const b = instantiate(lfo, { sampleRate }, { name: 'b' });
  return { process() { forSample(i => {
    output.ch(0).at(i).write(a.tick(input.ch(0).at(i), input.ch(1).at(i).gt(0), input.ch(2).at(i)));
    output.ch(1).at(i).write(b.tick(f32(7), bool(false), f32(0)));
  }); } };
});

for (const sampleRate of rates) {
  test(`sine reference, wrap, rate limits and independent instances at ${sampleRate}`, async () => {
    const size = 16384;
    for (const rate of [0, -1, 0.01, 20, 30]) {
      const controls = [new Float32Array(size).fill(rate), new Float32Array(size), new Float32Array(size)];
      const result = await renderOffline(fixture(sampleRate), { sampleRate, duration: size / sampleRate, inputs: { controls } });
      const frequency = Math.max(0, Math.min(20, Math.fround(rate)));
      const expected = Array.from({ length: size }, (_, n) => Math.sin(2 * Math.PI * frequency * n / sampleRate));
      close(result.outputs.main[0], expected);
      close(result.outputs.main[1], Array.from({ length: size }, (_, n) => Math.sin(2 * Math.PI * 7 * n / sampleRate)));
      if (rate === 20) expect(() => close(result.outputs.main[0], expected.map(x => -x))).toThrow();
    }
  });

  test(`continuous rate changes, hold, reset phase and state continuation at ${sampleRate}`, async () => {
    const size = 256;
    const controls = [Float32Array.from({ length: size }, (_, n) => n < 64 ? n / 4 : n < 128 ? 0 : 20 - (n - 128) / 8),
      Float32Array.from({ length: size }, (_, n) => n === 0 || n === 96 || n === 160 ? 1 : 0),
      Float32Array.from({ length: size }, (_, n) => n < 96 ? 0.25 : n < 160 ? -0.25 : 1.125)];
    const processor = fixture(sampleRate);
    const result = await renderOffline(processor, { sampleRate, duration: size / sampleRate, inputs: { controls } });
    // Integral of the independently supplied rate schedule, restarting only at
    // explicit reset indices; output precedes the current sample's increment.
    const expected = Array.from({ length: size }, (_, n) => {
      const start = n < 96 ? 0 : n < 160 ? 96 : 160;
      const phase = start === 0 ? 0.25 : start === 96 ? 0.75 : 0.125;
      const sum = Array.from(controls[0].slice(start, n)).reduce((a, b) => a + b, 0);
      return Math.sin(2 * Math.PI * (phase + sum / sampleRate));
    });
    close(result.outputs.main[0], expected);
    for (let n = 65; n < 96; n++) expect(result.outputs.main[0][n]).toBe(result.outputs.main[0][64]);
    // Same-schema snapshots resume phase rather than implicitly resetting it.
    const resumed = await renderOffline(processor, { sampleRate, duration: 128 / sampleRate, restore: result.state,
      inputs: { controls: [new Float32Array(128).fill(10), new Float32Array(128), new Float32Array(128)] } });
    const elapsed = Array.from(controls[0].slice(160)).reduce((a, b) => a + b, 0);
    close(resumed.outputs.main[0], Array.from({ length: 128 }, (_, n) => Math.sin(2 * Math.PI * (0.125 + (elapsed + n * 10) / sampleRate))));
  });

  test(`held reset and very small rate do not leak state or stall phase at ${sampleRate}`, async () => {
    const processor = fixture(sampleRate);
    const rate = new Float32Array(256).fill(0.0001);
    const reset = new Float32Array(256); reset.fill(1, 0, 128);
    const result = await renderOffline(processor, { sampleRate, duration: 256 / sampleRate,
      inputs: { controls: [rate, reset, new Float32Array(256).fill(0.5)] } });
    close(result.outputs.main[0], Array.from({ length: 256 }, (_, n) => Math.sin(2 * Math.PI * (0.5 + Math.max(0, n - 127) * rate[0] / sampleRate))), 1e-7);
    expect(Math.abs(result.outputs.main[0][255])).toBeGreaterThan(1e-7);
  });

  test(`destination-unit depth, continuous depth changes and final clamping at ${sampleRate}`, async () => {
    const size = 256;
    const processor = defineProcessor(() => {
      const input = audioInput({ channels: 2, name: 'controls' });
      const output = audioOutput({ channels: 3, name: 'main' });
      return { process() { forSample(i => {
        const signal = input.ch(0).at(i), depth = input.ch(1).at(i);
        output.ch(0).at(i).write(modulatePitch(f32(440), signal, depth.mul(24), 0.45 * sampleRate));
        output.ch(1).at(i).write(modulateCutoff(f32(1000), signal, depth.mul(8), Math.min(20000, 0.45 * sampleRate)));
        output.ch(2).at(i).write(modulateDelay(f32(0.02), signal, depth.mul(0.05), 1 / sampleRate, 0.04));
      }); } };
    });
    const signal = Float32Array.from({ length: size }, (_, n) => n < 128 ? -1 : 1);
    const depth = Float32Array.from({ length: size }, (_, n) => n % 128 / 32 - 1);
    const result = await renderOffline(processor, { sampleRate, duration: size / sampleRate, inputs: { controls: [signal, depth] } });
    const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
    close(result.outputs.main[0], Array.from(depth, (d, n) => clamp(440 * 2 ** (signal[n] * clamp(d * 24, -24, 24) / 12), 0, 0.45 * sampleRate)), 0.001);
    close(result.outputs.main[1], Array.from(depth, (d, n) => clamp(1000 * 2 ** (signal[n] * clamp(d * 8, -8, 8)), 20, Math.min(20000, 0.45 * sampleRate))), 0.02);
    close(result.outputs.main[2], Array.from(depth, (d, n) => clamp(0.02 + signal[n] * clamp(d * 0.05, 0, 0.05), 1 / sampleRate, 0.04)), 1e-8);
  });
}
