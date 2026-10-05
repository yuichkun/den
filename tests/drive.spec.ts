import { afterAll, expect, test } from 'vitest';
import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, inspect, instantiate, select } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { drive, reduction, type DriveConfig, type DriveCurve } from '../src/drive.js';
import { aliasResidual, amplitude, driveReference } from './fixtures/drive-reference.js';

const rates = [44100, 48000, 96000];
const curves: DriveCurve[] = ['hard', 'soft', 'asymmetric', 'fold'];
const qualities = ['direct', 'adaa'] as const;
const fill = (n: number, x = 0) => new Float32Array(n).fill(x);
const observations: object[] = [];
afterAll(() => { mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/drive-measurements.json', JSON.stringify({ status: 'CANDIDATE', observations }, null, 2)); });
function fixture(config: DriveConfig) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 4, name: 'main' }), output = audioOutput({ channels: 2, name: 'main' });
    const unit = instantiate(drive, config, { name: 'drive' });
    const isolated = instantiate(drive, config, { name: 'isolated' });
    return { process() { forSample(i => {
      output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), input.ch(1).at(i), input.ch(2).at(i), input.ch(3).at(i).gt(0)));
      output.ch(1).at(i).write(isolated.tick(f32(0), input.ch(1).at(i), input.ch(2).at(i), bool(false)));
    }); } };
  });
}
async function render(config: DriveConfig, input: Float32Array[], restore?: Uint8Array) {
  const result = await renderOffline(fixture(config), { sampleRate: config.sampleRate, duration: input[0].length / config.sampleRate, inputs: { main: input }, restore });
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  expect(result.outputs.main[0].every(Number.isFinite)).toBe(true);
  expect(result.outputs.main[1].every(x => x === 0)).toBe(true);
  return result;
}
function error(a: ArrayLike<number>, b: ArrayLike<number>) {
  expect(a.length).toBe(b.length);
  let result = 0; for (let i = 0; i < a.length; i++) result = Math.max(result, Math.abs(a[i] - b[i]));
  return result;
}

for (const sampleRate of rates) {
  test(`all curves/qualities, boundaries, near-equal samples, modulation and bounds at ${sampleRate}`, async () => {
    const n = 1024;
    const boundaries = [-8, -3.000001, -3, -2.999999, -1.000001, -1, -0.999999, -0.500001, -0.5, -0.499999, 0, 0.499999, 0.5, 0.999999, 1, 1.000001, 2.999999, 3, 3.000001, 8];
    const input = Float32Array.from({ length: n }, (_, i) => boundaries[Math.floor(i / 3) % boundaries.length]);
    const gain = Float32Array.from(input, (_, i) => i < 512 ? 1 : [0, 0.125, 2, 32, 100, -1][i % 6]);
    const mix = Float32Array.from(input, (_, i) => i < 512 ? 1 : [-1, 0, 0.3, 1, 2][i % 5]);
    const resets = fill(n); for (const i of [0, 127, 128, 129, 511, 512]) resets[i] = 1;
    for (const curve of curves) for (const quality of qualities) {
      const result = await render({ sampleRate, curve, quality }, [input, gain, mix, resets]);
      const expected = driveReference(input, gain, mix, resets, curve, quality);
      expect(error(result.outputs.main[0], expected)).toBeLessThan(5e-6);
      expect(error(input, expected)).toBeGreaterThan(1); // bypass cannot pass
      expect(Math.max(...result.outputs.main[0].map(Math.abs))).toBeLessThanOrEqual(8);
    }
  }, 60000);

  test(`impulse, reset, snapshot continuation and instance isolation at ${sampleRate}`, async () => {
    const n = 512, input = Float32Array.from({ length: n }, (_, i) => i === 0 || i === 128 ? 0.5 : i > 192 ? 0.2 * Math.sin(i) : 0);
    const channels = [input, fill(n, 1), fill(n, 1), fill(n)]; channels[3][128] = 1;
    for (const curve of curves) for (const quality of qualities) {
      const config = { sampleRate, curve, quality };
      const whole = await render(config, channels);
      const first = await render(config, channels.map(x => x.slice(0, 256)));
      const next = await render(config, channels.map(x => x.slice(256)), first.state);
      expect(error(next.outputs.main[0], whole.outputs.main[0].slice(256))).toBe(0);
      expect(error(whole.outputs.main[0], driveReference(...channels as [Float32Array, Float32Array, Float32Array, Float32Array], curve, quality))).toBeLessThan(5e-6);
      if (quality === 'adaa') expect(Object.keys(inspect(first.state).slots).some(x => x.includes('previous-driven-scaled'))).toBe(true);
      expect(whole.outputs.main[0][128]).toBe(whole.outputs.main[0][0]);
      if (curve === 'hard') {
        expect(Array.from(whole.outputs.main[0].slice(0, 3))).toEqual(quality === 'adaa' ? [0.25, 0.25, 0] : [0.5, 0, 0]);
      }
    }
  }, 60000);

  test(`matched dry impulse and linear ADAA frequency response at ${sampleRate}`, async () => {
    const n = 4096, bin = 997;
    const input = Float32Array.from({ length: n * 2 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * bin * i / n));
    for (const mix of [0, 0.3, 1]) {
      const out = (await render({ sampleRate, curve: 'hard', quality: 'adaa' }, [input, fill(n * 2, 1), fill(n * 2, mix), fill(n * 2)])).outputs.main[0].slice(n);
      expect(Math.abs(amplitude(out, bin) - 0.2 * Math.cos(Math.PI * bin / n))).toBeLessThan(2e-7);
      const phased = Float32Array.from({ length: n }, (_, i) => 0.2 * Math.cos(Math.PI * bin / n) * Math.sin(2 * Math.PI * bin * (i - 0.5) / n));
      expect(error(out, phased)).toBeLessThan(5e-8); // signed half-sample phase, not just magnitude
    }
  }, 30000);

  test(`soft cubic harmonic amplitudes and two-tone intermodulation at ${sampleRate}`, async () => {
    const n = 8192, bin = 37, a = 0.5;
    const input = Float32Array.from({ length: n }, (_, i) => a * Math.sin(2 * Math.PI * bin * i / n));
    const out = (await render({ sampleRate, curve: 'soft', quality: 'direct' }, [input, fill(n, 1), fill(n, 1), fill(n)])).outputs.main[0];
    expect(Math.abs(amplitude(out, bin) - (1.5 * a - 0.375 * a ** 3))).toBeLessThan(2e-7);
    expect(Math.abs(amplitude(out, 3 * bin) - a ** 3 / 8)).toBeLessThan(2e-7);
    expect(amplitude(out, 2 * bin)).toBeLessThan(1e-7);
    const b1 = 97, b2 = 151, level = 0.2;
    const pair = Float32Array.from(input, (_, i) => level * (Math.sin(2 * Math.PI * b1 * i / n) + Math.sin(2 * Math.PI * b2 * i / n)));
    const pairOut = (await render({ sampleRate, curve: 'soft', quality: 'direct' }, [pair, fill(n, 1), fill(n, 1), fill(n)])).outputs.main[0];
    expect(Math.abs(amplitude(pairOut, 2 * b1 - b2) - 3 * level ** 3 / 8)).toBeLessThan(2e-7);
    expect(Math.abs(amplitude(pairOut, 2 * b2 - b1) - 3 * level ** 3 / 8)).toBeLessThan(2e-7);
    observations.push({ sampleRate, check: 'soft-cubic-THD', thd: amplitude(out, 3 * bin) / amplitude(out, bin), imdSideband: amplitude(pairOut, 2 * b1 - b2) });
  }, 30000);

  test(`ADAA reduces measured folded energy against direct quality at ${sampleRate}`, async () => {
    const n = 8192;
    for (const curve of curves) for (const bin of [997, 1709]) {
      const input = Float32Array.from({ length: n * 2 }, (_, i) => 3 * Math.sin(2 * Math.PI * bin * i / n));
      const outputs = [];
      for (const quality of qualities) outputs.push((await render({ sampleRate, curve, quality }, [input, fill(n * 2, 1), fill(n * 2, 1), fill(n * 2)])).outputs.main[0].slice(n));
      const [direct, adaa] = outputs.map(x => aliasResidual(x, bin));
      observations.push({ sampleRate, curve, bin, directAliasRms: direct, adaaAliasRms: adaa, improvementDb: 20 * Math.log10(direct / adaa), fundamentalDirect: amplitude(outputs[0], bin), fundamentalAdaa: amplitude(outputs[1], bin) });
      expect(adaa).toBeLessThan(direct / 2); // >= 6 dB; not a universal bandlimit
    }
  }, 60000);

  test(`explicit DC blocker step, corner, reset and snapshot at ${sampleRate}`, async () => {
    const n = 32768, cutoff = 200, pole = Math.exp(-2 * Math.PI * cutoff / sampleRate);
    const config = { sampleRate, curve: 'hard' as const, quality: 'direct' as const, dcBlockHz: cutoff };
    const input = fill(n, 0.25), reset = fill(n); reset[128] = 1;
    const result = await render(config, [input, fill(n, 1), fill(n, 1), reset]);
    const expected = Float32Array.from(input, (_, i) => 0.25 * pole ** (i < 128 ? i : i - 128));
    expect(error(result.outputs.main[0], expected)).toBeLessThan(1e-7);
    expect(Math.abs(result.outputs.main[0][n - 1])).toBeLessThan(1e-20);
    const first = await render(config, [fill(128, 0.25), fill(128, 1), fill(128, 1), fill(128)]);
    const next = await render(config, [fill(128, 0.25), fill(128, 1), fill(128, 1), fill(128)], first.state);
    expect(error(next.outputs.main[0], Float32Array.from({ length: 128 }, (_, i) => 0.25 * pole ** (128 + i)))).toBeLessThan(1e-7);
    const bin = Math.round(cutoff * n / sampleRate), frequency = sampleRate * bin / n;
    const tone = Float32Array.from({ length: n * 2 }, (_, i) => 0.25 * Math.sin(2 * Math.PI * bin * i / n));
    const out = (await render(config, [tone, fill(n * 2, 1), fill(n * 2, 1), fill(n * 2)])).outputs.main[0].slice(n);
    const w = 2 * Math.PI * frequency / sampleRate;
    const gain = Math.sqrt((2 - 2 * Math.cos(w)) / (1 + pole * pole - 2 * pole * Math.cos(w)));
    expect(Math.abs(amplitude(out, bin) / 0.25 - gain)).toBeLessThan(1e-6);
  }, 30000);
}

test('invalid construction is rejected, graph-level non-finite controls are bounded without scrubbing, and tiny history survives', async () => {
  for (const sampleRate of [0, 7999, 192001, NaN, Infinity]) expect(() => fixture({ sampleRate, curve: 'hard' })).toThrow(/sampleRate/);
  for (const config of [{ curve: 'unknown' }, { quality: 'unknown' }, { dcBlockHz: NaN }, { dcBlockHz: -1 }, { dcBlockHz: 201 }]) expect(() => fixture({ sampleRate: 48000, curve: 'hard', ...config } as DriveConfig)).toThrow();
  const processor = defineProcessor(() => {
    const output = audioOutput({ channels: 4, name: 'main' });
    const tiny = instantiate(drive, { sampleRate: 48000, curve: 'hard' }, { name: 'tiny' });
    const bad = instantiate(drive, { sampleRate: 48000, curve: 'fold', dcBlockHz: 200 }, { name: 'bad' });
    const dry = instantiate(drive, { sampleRate: 48000, curve: 'hard' }, { name: 'dry' });
    const reduced = instantiate(reduction, { sampleRate: 48000 }, { name: 'reduced' });
    return { process() { forSample(i => {
      const x = select(i.eq(0), f32(1e-40), f32(0));
      output.ch(0).at(i).write(tiny.tick(x, f32(32), f32(1), bool(false)));
      output.ch(2).at(i).write(dry.tick(x, f32(32), f32(0), bool(false)));
      const invalid = select(i.lt(32), f32(NaN), select(i.lt(64), f32(Infinity), f32(-Infinity)));
      output.ch(1).at(i).write(bad.tick(invalid, invalid, invalid, bool(false)));
      output.ch(3).at(i).write(reduced.tick(invalid, invalid, invalid, invalid, bool(false)));
    }); } };
  });
  const result = await renderOffline(processor, { sampleRate: 48000, duration: 128 / 48000 });
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  expect(result.outputs.main.every(x => x.every(Number.isFinite))).toBe(true);
  expect(result.outputs.main[0][0]).toBe(Math.fround(Math.fround(1e-40) * 16));
  expect(result.outputs.main[0][1]).toBe(result.outputs.main[0][0]);
  expect(result.outputs.main[2][0]).toBe(Math.fround(Math.fround(1e-40) / 2));
  expect(result.outputs.main[2][1]).toBe(result.outputs.main[2][0]);
}, 30000);

test('every curve and quality preserves recoverable tiny input without cancellation and handles invalid graph input', async () => {
  for (const curve of curves) for (const quality of qualities) {
    const processor = defineProcessor(() => {
      const output = audioOutput({ channels: 2, name: 'main' });
      const tiny = instantiate(drive, { sampleRate: 48000, curve, quality }, { name: 'tiny' });
      const invalid = instantiate(drive, { sampleRate: 48000, curve, quality, dcBlockHz: 20 }, { name: 'invalid' });
      return { process() { forSample(i => {
        output.ch(0).at(i).write(tiny.tick(select(i.eq(0), f32(-1e-40), f32(0)), f32(32), f32(1), bool(false)));
        const bad = select(i.lt(32), f32(NaN), select(i.lt(64), f32(Infinity), f32(-Infinity)));
        output.ch(1).at(i).write(invalid.tick(bad, f32(32), f32(1), bool(false)));
      }); } };
    });
    const result = await renderOffline(processor, { sampleRate: 48000, duration: 128 / 48000 });
    expect(result.diagnostics.scrubbedSamples).toBe(0);
    expect(result.outputs.main.every(ch => ch.every(Number.isFinite))).toBe(true);
    const slope = curve === 'soft' || curve === 'asymmetric' ? 1.5 : 1;
    const initial = Math.fround(Math.fround(-1e-40) * 32 * slope / (quality === 'adaa' ? 2 : 1));
    expect(result.outputs.main[0][0]).toBe(initial);
    expect(result.outputs.main[0][1]).toBe(quality === 'adaa' ? initial : 0);
  }
}, 30000);

for (const sampleRate of rates) test(`reduction signed levels, holds/control changes, reset and snapshot at ${sampleRate}`, async () => {
  const processor = defineProcessor(() => {
    const input = audioInput({ channels: 5, name: 'main' }), output = audioOutput({ channels: 2, name: 'main' });
    const unit = instantiate(reduction, { sampleRate }, { name: 'reduction' });
    const isolated = instantiate(reduction, { sampleRate }, { name: 'isolated' });
    return { process() { forSample(i => {
      output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), input.ch(1).at(i), input.ch(2).at(i), input.ch(3).at(i), input.ch(4).at(i).gt(0)));
      output.ch(1).at(i).write(isolated.tick(f32(0), f32(2), f32(4096), f32(1), bool(false)));
    }); } };
  });
  const n = 1024, input = Float32Array.from({ length: n }, (_, i) => i < 256 ? (i % 65 - 32) / 16 : Math.sin(i));
  const bits = Float32Array.from(input, (_, i) => [2, 4.9, 24, 200, -1][Math.floor(i / 64) % 5]);
  const hold = Float32Array.from(input, (_, i) => i < 128 ? 1 : [3.9, 17, 4096, 0][Math.floor(i / 29) % 4]);
  const mix = Float32Array.from(input, (_, i) => i < 512 ? 1 : [0, 0.4, 1][i % 3]);
  const resets = fill(n); for (const i of [0, 127, 128, 129, 501, 777]) resets[i] = 1;
  const channels = [input, bits, hold, mix, resets];
  const options = (data: Float32Array[], restore?: Uint8Array) => ({ sampleRate, duration: data[0].length / sampleRate, inputs: { main: data }, restore });
  const whole = await renderOffline(processor, options(channels));
  let nextCapture = 0, held = 0;
  const expected = Float32Array.from(input, (x, i) => {
    x = Math.max(-1, Math.min(1, x));
    if (resets[i] || i >= nextCapture) {
      const levels = 2 ** (Math.floor(Math.max(2, Math.min(24, bits[i]))) - 1);
      held = Math.max(-levels, Math.min(levels - 1, Math.round(x * levels))) / levels;
      nextCapture = i + Math.floor(Math.max(1, Math.min(4096, hold[i])));
    }
    return x * (1 - mix[i]) + held * mix[i];
  });
  expect(error(whole.outputs.main[0], expected)).toBeLessThan(1e-7);
  expect(whole.outputs.main[1].every(x => x === 0)).toBe(true);
  expect(whole.diagnostics.scrubbedSamples).toBe(0);
  const first = await renderOffline(processor, options(channels.map(x => x.slice(0, 512))));
  const next = await renderOffline(processor, options(channels.map(x => x.slice(512)), first.state));
  expect(error(next.outputs.main[0], whole.outputs.main[0].slice(512))).toBe(0);
  expect(error(input, expected)).toBeGreaterThan(0.5);
}, 30000);

test('maximum reduction hold spans block boundaries exactly and sample reduction deliberately aliases', async () => {
  const sampleRate = 48000, n = 8192;
  for (const holdSamples of [4, 4096]) {
    const processor = defineProcessor(() => {
      const input = audioInput({ channels: 1, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
      const unit = instantiate(reduction, { sampleRate }, { name: 'reduction' });
      return { process() { forSample(i => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), f32(24), f32(holdSamples), f32(1), bool(false)))); } };
    });
    const input = Float32Array.from({ length: n }, (_, i) => holdSamples === 4096 ? (i < 4096 ? 0.25 : -0.75) : 0.8 * Math.sin(2 * Math.PI * 2500 * i / n));
    const result = await renderOffline(processor, { sampleRate, duration: n / sampleRate, inputs: { main: [input] } });
    const output = result.outputs.main[0];
    if (holdSamples === 4096) {
      expect(output.slice(0, 4096).every(x => x === 0.25)).toBe(true);
      expect(output.slice(4096).every(x => x === -0.75)).toBe(true);
    } else {
      expect(amplitude(output, 452)).toBeGreaterThan(0.5);
      expect(amplitude(output, 2500)).toBeLessThan(0.3);
    }
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
}, 30000);
