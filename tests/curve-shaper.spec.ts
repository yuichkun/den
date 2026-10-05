import { afterAll, expect, test } from 'vitest';
import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, select } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { curveShaper, type CurveShaperConfig } from '../src/curve-shaper.js';
import { curveShaperReference } from './fixtures/curve-shaper-reference.js';
import { aliasResidual, amplitude } from './fixtures/drive-reference.js';
const rates = [44100, 48000, 96000];
const fill = (n: number, value = 0) => new Float32Array(n).fill(value);
const observations: object[] = [];
afterAll(() => { mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/curve-shaper-measurements.json', JSON.stringify({ status: 'CANDIDATE', observations }, null, 2)); });
function fixture(config: CurveShaperConfig) {
  return defineProcessor(() => {
    const input = audioInput({ name: 'main', channels: config.pointCount + 4 });
    const output = audioOutput({ name: 'main', channels: 2 });
    const unit = instantiate(curveShaper, config, { name: 'curve' });
    const isolated = instantiate(curveShaper, config, { name: 'isolated' });
    return { process() { forSample(i => {
      const controls = { gain: input.ch(1).at(i), mix: input.ch(2).at(i), reset: input.ch(3).at(i).gt(0), ordinates: Array.from({ length: config.pointCount }, (_, j) => input.ch(j + 4).at(i)) };
      output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), controls));
      output.ch(1).at(i).write(isolated.tick(f32(0), { ...controls, ordinates: controls.ordinates.map(() => f32(0)) }));
    }); } };
  });
}
function error(a: ArrayLike<number>, b: ArrayLike<number>) {
  expect(a.length).toBe(b.length);
  let maximum = 0; for (let i = 0; i < a.length; i++) maximum = Math.max(maximum, Math.abs(a[i] - b[i]));
  return maximum;
}
async function render(config: CurveShaperConfig, input: Float32Array[], restore?: Uint8Array) {
  const result = await renderOffline(fixture(config), { sampleRate: config.sampleRate, duration: input[0].length / config.sampleRate, inputs: { main: input }, restore });
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  expect(result.outputs.main.every(ch => ch.every(Number.isFinite))).toBe(true);
  expect(result.outputs.main[1].every(x => x === 0)).toBe(true);
  return result;
}
for (const sampleRate of rates) {
  test(`editable minimum/maximum LUTs, interpolation/quadrature, gain/mix edits and bounds at ${sampleRate}`, async () => {
    const n = 1024;
    for (const pointCount of [2, 17]) for (const quality of ['direct', 'adaa'] as const) {
      const x = Float32Array.from({ length: n }, (_, i) => i < 512 ? [-8, -1.000001, -1, -.999999, -.75, -.1250001, -.125, -.1249999, -1e-8, 0, 1e-8, .1249999, .125, .1250001, .999999, 1, 1.000001, 8][Math.floor(i / 3) % 18] : 2 * Math.sin(i * .37));
      const ordinates = Array.from({ length: pointCount }, (_, j) => Float32Array.from(x, (_, i) => i < 256 ? 2 * j / (pointCount - 1) - 1 : i < 512 ? .3 + .7 * Math.sin(j * .7) : [1.5, -2, .1 * j, -1, 1][Math.floor(i / 29 + j) % 5]));
      const channels = [x, Float32Array.from(x, (_, i) => i < 512 ? 1 : [0, -1, .25, 4, 32, 100][i % 6]), Float32Array.from(x, (_, i) => i < 512 ? 1 : [-1, 0, .3, 1, 2][i % 5]), Float32Array.from(x, (_, i) => [0, 127, 128, 129, 501, 777].includes(i) ? 1 : 0), ...ordinates];
      const result = await render({ sampleRate, pointCount, quality }, channels);
      const oracleError = error(result.outputs.main[0], curveShaperReference(channels, quality));
      expect(oracleError).toBeLessThan(8e-7);
      expect(Math.max(...result.outputs.main[0].map(Math.abs))).toBeLessThanOrEqual(8);
      expect(error(x, result.outputs.main[0])).toBeGreaterThan(1); // bypass counterexample
      observations.push({ sampleRate, pointCount, quality, oracleError });
    }
  }, 120000);
  test(`reset before current sample, exact continuation, and current-curve edit semantics at ${sampleRate}`, async () => {
    const n = 512;
    for (const quality of ['direct', 'adaa'] as const) {
      const channels = [Float32Array.from({ length: n }, (_, i) => i < 256 ? .7 : .2 * Math.sin(i)), fill(n, 2), fill(n, .4), fill(n), fill(n, -1), fill(n), fill(n, 1)];
      channels[3][128] = 1;
      for (let i = 0; i < n; i++) {
        channels[4][i] = i < 193 ? -1 : -.25;
        channels[5][i] = i < 193 ? 0 : .3;
        channels[6][i] = i < 193 ? 1 : .7;
      }
      const config = { sampleRate, pointCount: 3, quality };
      const whole = await render(config, channels);
      const first = await render(config, channels.map(ch => ch.slice(0, 256)));
      const second = await render(config, channels.map(ch => ch.slice(256)), first.state);
      expect(error(whole.outputs.main[0], curveShaperReference(channels, quality))).toBeLessThan(8e-7);
      expect(error(second.outputs.main[0], whole.outputs.main[0].slice(256))).toBe(0);
      expect(whole.outputs.main[0][128]).toBe(whole.outputs.main[0][0]);
      // The input is unchanged at the edit: immediate new endpoint, no primitive-jump spike.
      expect(whole.outputs.main[0][193]).toBeCloseTo(.7 * .6 + .7 * .4, 6);
    }
  }, 60000);
  test(`linear LUT and dry path share signed phase and gain at ${sampleRate}`, async () => {
    const n = 4096, bin = 997;
    const x = Float32Array.from({ length: n * 2 }, (_, i) => .2 * Math.sin(2 * Math.PI * bin * i / n));
    for (const pointCount of [2, 3]) for (const mix of [0, .4, 1]) {
      const channels = [x, fill(n * 2, 1), fill(n * 2, mix), fill(n * 2), ...Array.from({ length: pointCount }, (_, j) => fill(n * 2, 2 * j / (pointCount - 1) - 1))];
      const output = (await render({ sampleRate, pointCount, quality: 'adaa' }, channels)).outputs.main[0].slice(n);
      const expected = Float32Array.from({ length: n }, (_, i) => .2 * Math.cos(Math.PI * bin / n) * Math.sin(2 * Math.PI * bin * (i - .5) / n));
      expect(error(output, expected)).toBeLessThan(5e-8);
    }
  }, 60000);
  test(`fixed user curves reduce the specified folded-alias fixtures at ${sampleRate}`, async () => {
    const n = 8192;
    for (const points of [[-1, -1, 0, 1, 1], [-.5, -.5, 0, 1, 1]]) for (const bin of [997, 1709]) {
      const x = Float32Array.from({ length: n * 2 }, (_, i) => 3 * Math.sin(2 * Math.PI * bin * i / n));
      const channels = [x, fill(n * 2, 1), fill(n * 2, 1), fill(n * 2), ...points.map(y => fill(n * 2, y))];
      const outputs = [];
      for (const quality of ['direct', 'adaa'] as const) outputs.push((await render({ sampleRate, pointCount: points.length, quality }, channels)).outputs.main[0].slice(n));
      const [direct, adaa] = outputs.map(x => aliasResidual(x, bin));
      const improvementDb = 20 * Math.log10(direct / adaa);
      expect(improvementDb).toBeGreaterThanOrEqual(6);
      observations.push({ sampleRate, points, bin, directAliasRms: direct, adaaAliasRms: adaa, improvementDb, fundamentalDirect: amplitude(outputs[0], bin), fundamentalAdaa: amplitude(outputs[1], bin) });
    }
  }, 120000);
}
test('invalid config and ordinate count reject at capture', () => {
  for (const config of [{ sampleRate: NaN }, { sampleRate: 7999 }, { sampleRate: 192001 }, { pointCount: 1 }, { pointCount: 18 }, { pointCount: 2.5 }, { quality: '4x' }]) {
    expect(() => fixture({ sampleRate: 48000, pointCount: 3, ...config } as CurveShaperConfig)).toThrow();
  }
  expect(() => defineProcessor(() => {
    const unit = instantiate(curveShaper, { sampleRate: 48000, pointCount: 3 }, { name: 'invalid-length' });
    return { process() { forSample(() => unit.tick(f32(0), { gain: f32(1), mix: f32(1), reset: bool(false), ordinates: [f32(-1), f32(1)] })); } };
  })).toThrow(/ordinates/);
});
test('graph-level invalid controls stay finite, tiny linear ordinates survive native histories', async () => {
  for (const pointCount of [2, 3]) for (const quality of ['direct', 'adaa'] as const) {
    const processor = defineProcessor(() => {
      const output = audioOutput({ name: 'main', channels: 3 });
      const tiny = instantiate(curveShaper, { sampleRate: 48000, pointCount, quality }, { name: 'tiny' });
      const tinyDry = instantiate(curveShaper, { sampleRate: 48000, pointCount, quality }, { name: 'tiny-dry' });
      const invalid = instantiate(curveShaper, { sampleRate: 48000, pointCount, quality }, { name: 'invalid' });
      return { process() { forSample(i => {
        const ordinates = Array.from({ length: pointCount }, (_, j) => f32(2 * j / (pointCount - 1) - 1));
        const controls = { gain: f32(32), mix: f32(1), reset: bool(false), ordinates };
        const x = select(i.eq(0), f32(-1e-40), f32(0));
        output.ch(0).at(i).write(tiny.tick(x, controls));
        output.ch(1).at(i).write(tinyDry.tick(x, { ...controls, mix: f32(0) }));
        const bad = select(i.lt(32), f32(NaN), select(i.lt(64), f32(Infinity), f32(-Infinity)));
        output.ch(2).at(i).write(invalid.tick(bad, { gain: bad, mix: bad, reset: i.eq(64), ordinates: ordinates.map(() => bad) }));
      }); } };
    });
    const result = await renderOffline(processor, { sampleRate: 48000, duration: 128 / 48000 });
    expect(result.diagnostics.scrubbedSamples).toBe(0);
    expect(result.outputs.main.every(ch => ch.every(Number.isFinite))).toBe(true);
    for (let ch = 0; ch < 2; ch++) {
      const expected = Math.fround(Math.fround(-1e-40) * (ch === 0 ? 32 : 1) / (quality === 'adaa' ? 2 : 1));
      expect(result.outputs.main[ch][0]).toBe(expected);
      expect(result.outputs.main[ch][1]).toBe(quality === 'adaa' ? expected : 0);
    }
  }
}, 60000);
test('tiny ordinate edits and a maximum-slope near-equal knot crossing remain bounded', async () => {
  for (const quality of ['direct', 'adaa'] as const) {
    const n = 256, tiny = Math.fround(1e-40);
    const channels = [fill(n, .25), fill(n, 1), fill(n, 1), fill(n), ...Array.from({ length: 17 }, () => Float32Array.from({ length: n }, (_, i) => i < 128 ? tiny : -tiny))];
    const result = await render({ sampleRate: 48000, pointCount: 17, quality }, channels);
    expect(result.outputs.main[0].slice(0, 128).every(x => x === tiny)).toBe(true);
    expect(result.outputs.main[0].slice(128).every(x => x === -tiny)).toBe(true);
    const crossing = [Float32Array.from({ length: n }, (_, i) => i % 2 ? 2e-8 : -2e-8), fill(n, 1), fill(n, 1), fill(n), ...Array.from({ length: 17 }, (_, i) => fill(n, i % 2 ? 1 : -1))];
    const output = await render({ sampleRate: 48000, pointCount: 17, quality }, crossing);
    expect(error(output.outputs.main[0], curveShaperReference(crossing, quality))).toBeLessThanOrEqual(2.5e-7);
  }
}, 30000);
test('all 2..17 symmetric knot counts preserve exact silence and signed recoverable tiny input', async () => {
  for (let pointCount = 2; pointCount <= 17; pointCount++) for (const quality of ['direct', 'adaa'] as const) {
    const n = 128, values = Float32Array.from({ length: pointCount }, (_, i) => (2 * i - pointCount + 1) / (pointCount - 1));
    const x = fill(n); x[1] = Math.fround(-1e-40); x[3] = Math.fround(1e-40);
    const channels = [x, fill(n, 1), fill(n, 1), fill(n), ...Array.from(values, y => fill(n, y))];
    const result = await render({ sampleRate: 48000, pointCount, quality }, channels);
    const left = Math.floor((pointCount - 2) / 2), slope = (values[left + 1] - values[left]) * (pointCount - 1) / 2;
    const expected = Float32Array.from(x, (v, i) => slope * (quality === 'direct' ? v : (v + (i ? x[i - 1] : 0)) / 2));
    expect(Array.from(result.outputs.main[0])).toEqual(Array.from(expected));
    expect(result.outputs.main[0][0]).toBe(0);
    expect(result.outputs.main[0][1]).toBeLessThan(0);
    expect(result.outputs.main[0][3]).toBeGreaterThan(0);
  }
}, 60000);
test('retained fractional-knot implementation fails the exact-silence oracle', async () => {
  const { curveShaper: rejected } = await import('./fixtures/rejected-fractional-curve-shaper.js');
  const processor = defineProcessor(() => {
    const output = audioOutput({ channels: 1, name: 'main' });
    const unit = instantiate(rejected, { sampleRate: 48000, pointCount: 4, quality: 'direct' }, { name: 'rejected' });
    return { process() { forSample(i => output.ch(0).at(i).write(unit.tick(f32(0), {
      gain: f32(1), mix: f32(1), reset: bool(false), ordinates: [-1, -1 / 3, 1 / 3, 1].map(f32),
    }))); } };
  });
  const result = await renderOffline(processor, { sampleRate: 48000, duration: 128 / 48000 });
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  expect(Math.abs(result.outputs.main[0][0])).toBeGreaterThan(1e-18);
  expect(result.outputs.main[0][0]).not.toBe(0);
}, 30000);
