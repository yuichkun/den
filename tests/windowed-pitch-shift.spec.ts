import { test, expect } from 'vitest';
import { audioInput, audioOutput, defineProcessor, f32, forSample, instantiate, select } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { windowedPitchShift, type WindowedPitchShiftConfig } from '../src/windowed-pitch-shift.js';
import { complexBin, maxError, neighbor, pitchReference, ports } from './fixtures/windowed-pitch-shift-reference.js';

const rates = [44100, 48000, 96000];
function fixture(windowSamples: number) {
  return defineProcessor(ctx => {
    const input = audioInput({ name: 'main', channels: 4 }), output = audioOutput({ name: 'main', channels: 2 });
    const unit = instantiate(windowedPitchShift, { sampleRate: ctx.sampleRate, windowSamples }, { name: 'shift' });
    return { process() { forSample(i => {
      const result = unit.tick(input.ch(0).at(i), { ratio: input.ch(1).at(i), reset: input.ch(2).at(i).gt(0), retrigger: input.ch(3).at(i).gt(0) });
      output.ch(0).at(i).write(result.output); output.ch(1).at(i).write(f32(result.ratioRejected));
    }); } };
  });
}
async function render(rate: number, data: Float32Array[], width = 512, restore?: Uint8Array) {
  const result = await renderOffline(fixture(width), { sampleRate: rate, duration: (data[0].length - .25) / rate, inputs: { main: data }, restore });
  expect(result.outputs.main[0].length).toBe(data[0].length);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  expect(result.outputs.main[0].every(Number.isFinite)).toBe(true);
  return result;
}

for (const rate of rates) {
  test(`unity has the exact initial midpoint delay and fixed maximum tail at ${rate}`, async () => {
    for (const width of [32, 34, 512, 16384]) {
      const frames = Math.ceil((width + 384) / 128) * 128;
      const data = ports(frames, { 0: n => n === 0 ? 1 : n === 111 ? -.25 : 0 });
      const result = await render(rate, data, width), actual = result.outputs.main[0];
      const delay = 1 + width / 2;
      expect(actual[delay]).toBe(1); expect(actual[111 + delay]).toBe(-.25);
      expect(actual.filter(x => x !== 0)).toEqual(new Float32Array([1, -.25]));
      expect(actual.slice(111 + width + 2).every(x => x === 0)).toBe(true);
    }
  });

  test(`sinusoid read slope multiplies frequency, retaining analytic interpolation and phase at ${rate}`, async () => {
    for (const ratio of [.5, .75, 1, 1.25, 1.5, 2]) {
      const data = ports(8192, { 0: n => .5 * Math.cos(2 * Math.PI * n / 128), 1: ratio });
      const result = await render(rate, data), tail = result.outputs.main[0].slice(4096);
      const expected = Float32Array.from(tail, (_, j) => {
        const time = ratio * (4096 + j) - 1, before = Math.floor(time), fraction = time - before;
        return .5 * ((1 - fraction) * Math.cos(2 * Math.PI * before / 128) + fraction * Math.cos(2 * Math.PI * (before + 1) / 128));
      });
      expect(maxError(tail, expected)).toBeLessThan(6e-8);
      const desired = complexBin(tail, ratio / 128);
      expect(desired.magnitude).toBeGreaterThan(.4998);
      expect(Math.abs(Math.atan2(desired.imaginary, desired.real) + 2 * Math.PI / 128)).toBeLessThan(2e-6);
      if (ratio !== 1) expect(complexBin(tail, 1 / 128).magnitude).toBeLessThan(2e-7);
    }
  });

  test(`continuous edits, arbitrary wraps, retrigger/reset precedence and moving-state snapshots at ${rate}`, async () => {
    for (const width of [34, 512]) {
      const data = ports(4096, {
        0: n => n < 3072 ? .3 * Math.sin(n * .31) + .2 * Math.cos(n * .13) : 0,
        1: n => n < 600 ? 1.375 : n < 850 ? 1 : n < 1536 ? .63 : .5 + (n * 17 % 1024) / 1024 * 1.5,
        2: n => n === 1537 || n >= 2047 && n <= 2053 ? 1 : 0,
        3: n => n === 400 || n === 1537 || n >= 1801 && n <= 1808 || n === 2049 ? 1 : 0,
      });
      const result = await render(rate, data, width), expected = pitchReference(data, width);
      result.outputs.main.forEach((channel, i) => expect(maxError(channel, expected[i])).toBeLessThan(3e-7));
      const split = 256, first = await render(rate, data.map(x => x.slice(0, split)), width);
      const continued = await render(rate, data.map(x => x.slice(split)), width, first.state);
      result.outputs.main.forEach((channel, i) => expect(continued.outputs.main[i]).toEqual(channel.slice(split)));
      const cleared = await render(rate, ports(1024, { 2: n => n === 0 ? 1 : 0 }), width, first.state);
      expect(cleared.outputs.main[0].every(x => x === 0)).toBe(true);
      for (const n of [1537, 2047, 2048, 2049, 2050, 2051, 2052, 2053]) expect(result.outputs.main[0][n]).toBe(0);
      expect(result.outputs.main[0].slice(3072 + width + 1).every(x => x === 0)).toBe(true);
    }
  });

  test(`unity after modulation can cancel, retrigger preserves history and restores midpoint read at ${rate}`, async () => {
    // W=512, travel 128 at n=256: the two taps are separated by 256
    // samples and oppositely phased for this 512-sample carrier.
    const data = ports(3072, { 0: n => Math.cos(2 * Math.PI * n / 512), 1: n => n < 256 ? .5 : 1, 3: n => n >= 2048 ? 1 : 0 });
    const result = await render(rate, data);
    expect(Math.max(...result.outputs.main[0].slice(1024, 2048).map(Math.abs))).toBeLessThan(1e-7);
    for (let n = 2048; n < 3072; n++) expect(result.outputs.main[0][n]).toBe(data[0][n - 257]);
    // A unity-ratio bypass counterexample must differ materially.
    expect(maxError(result.outputs.main[0].slice(1024, 2048), data[0].slice(1024, 2048))).toBeGreaterThan(.99);
  });

  test(`known upward Nyquist fold remains an explicit alias counterexample at ${rate}`, async () => {
    const data = ports(8192, { 0: n => .5 * Math.cos(2 * Math.PI * .375 * n), 1: 2 });
    const result = await render(rate, data), tail = result.outputs.main[0].slice(4096);
    expect(complexBin(tail, .25).magnitude).toBeCloseTo(.5, 6);
    expect(maxError(result.outputs.main[0], pitchReference(data, 512)[0])).toBeLessThan(6e-8);
  });

  test(`convex interpolation preserves DC, finite extrema and tiny f32 values at ${rate}`, async () => {
    for (const value of [2 ** -149, -(2 ** -149), Math.fround(1e-40), -Math.fround(1e-40), Math.fround(3.4028234663852886e38), -Math.fround(3.4028234663852886e38)]) {
      const data = ports(1024, { 0: value, 1: n => .5 + (n * 13 % 256) / 256 * 1.5 });
      const result = await render(rate, data, 34);
      expect(result.outputs.main[0].slice(36).every(x => x === value)).toBe(true);
    }
    const maximum = Math.fround(3.4028234663852886e38);
    const data = ports(2048, { 0: n => n % 2 ? maximum : -maximum, 1: n => .5 + (n * 79 % 2048) / 2048 * 1.5 });
    const result = await render(rate, data), expected = pitchReference(data, 512)[0];
    let relative = 0;
    result.outputs.main[0].forEach((x, n) => { expect(Math.abs(x)).toBeLessThanOrEqual(maximum); relative = Math.max(relative, Math.abs(x / maximum - expected[n] / maximum)); });
    expect(relative).toBeLessThan(3e-7);
  });

  test(`neighboring f32 ratio endpoints reject precisely and keep the last valid speed at ${rate}`, async () => {
    const values = [.5, neighbor(.5, -1), neighbor(.5, 1), 2, neighbor(2, 1), neighbor(2, -1), -1, 0];
    const data = ports(1024, { 0: n => Math.sin(n * .31), 1: n => values[n % values.length], 2: n => n === 193 ? 1 : 0 });
    const result = await render(rate, data, 34), expected = pitchReference(data, 34);
    expect(Array.from(result.outputs.main[1])).toEqual(Array.from({ length: 1024 }, (_, n) => [0, 1, 0, 0, 1, 0, 1, 1][n % 8]));
    expect(maxError(result.outputs.main[0], expected[0])).toBeLessThan(3e-7);
  });
}

test('graph-native NaN/infinities reject without poisoning state, including reset', async () => {
  const processor = defineProcessor(ctx => {
    const output = audioOutput({ name: 'main', channels: 2 });
    const unit = instantiate(windowedPitchShift, { sampleRate: ctx.sampleRate, windowSamples: 32 }, { name: 'shift' });
    return { process() { forSample(i => {
      const ratio = select(i.lt(8), f32(NaN), select(i.eq(8), f32(.75), select(i.lt(64), f32(Infinity), f32(-Infinity))));
      const result = unit.tick(f32(.25), { ratio, reset: i.eq(80), retrigger: i.eq(80) });
      output.ch(0).at(i).write(result.output); output.ch(1).at(i).write(f32(result.ratioRejected));
    }); } };
  });
  const rate = 48000, result = await renderOffline(processor, { sampleRate: rate, duration: 128 / rate });
  const expected = pitchReference(ports(128, { 0: .25, 1: n => n < 8 ? NaN : n === 8 ? .75 : n < 64 ? Infinity : -Infinity, 2: n => n === 80 ? 1 : 0 }), 32);
  result.outputs.main.forEach((channel, i) => expect(maxError(channel, expected[i])).toBeLessThan(3e-8));
  expect(result.diagnostics.scrubbedSamples).toBe(0);
});

test('construction bounds reject invalid rates and windows; default and endpoints construct', () => {
  const construct = (config: WindowedPitchShiftConfig) => defineProcessor(() => {
    instantiate(windowedPitchShift, config, { name: 'shift' }); return { process() {} };
  });
  for (const sampleRate of [NaN, Infinity, 0, 7999, 48000.5, 192001]) expect(() => construct({ sampleRate })).toThrow(/windowedPitchShift/);
  for (const windowSamples of [NaN, Infinity, 0, 31, 33, 34.5, 16385, 16386]) expect(() => construct({ sampleRate: 48000, windowSamples })).toThrow(/windowedPitchShift/);
  for (const sampleRate of [8000, ...rates, 192000]) for (const windowSamples of [undefined, 32, 34, 16384]) expect(() => construct({ sampleRate, windowSamples })).not.toThrow();
});
