import { afterAll, expect, test } from 'vitest';
import { audioInput, audioOutput, bool, compile, defineProcessor, f32, forSample, inspect, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { characterFilter } from '../src/character-filter.js';
import { bounded, characterReference, dcReference, foldedResidual, linearReference, projection, saturation } from './fixtures/character-filter-reference.js';

const rates = [44100, 48000, 96000];
const fill = (n: number, value = 0) => new Float32Array(n).fill(value);
const peak = (x: ArrayLike<number>) => Array.from(x).reduce((p, v) => Math.max(p, Math.abs(v)), 0);
const error = (x: ArrayLike<number>, y: ArrayLike<number>) => {
  expect(x.length).toBe(y.length); return Array.from(x).reduce((e, v, i) => Math.max(e, Math.abs(v - y[i])), 0);
};
const evidence: object[] = [];
afterAll(() => { mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/character-filter-measurements.json', JSON.stringify({ status: 'CANDIDATE', runtimeStatus: 'NOT_CLEARED', evidence }, null, 2)); });
const processors = new Map<number, ReturnType<typeof defineProcessor>>();
function processor(sampleRate: number) {
  if (processors.has(sampleRate)) return processors.get(sampleRate)!;
  const p = defineProcessor(() => {
    const input = audioInput({ channels: 5, name: 'main' }), output = audioOutput({ channels: 2, name: 'main' });
    const unit = instantiate(characterFilter, { sampleRate }, { name: 'unit' });
    const isolated = instantiate(characterFilter, { sampleRate }, { name: 'isolated' });
    return { process() { forSample(i => {
      const y = unit.tick(input.ch(0).at(i), input.ch(1).at(i), input.ch(2).at(i), input.ch(3).at(i), input.ch(4).at(i).gt(0));
      const zero = isolated.tick(f32(0), input.ch(1).at(i), input.ch(2).at(i), input.ch(3).at(i), bool(false));
      // Consume the first result after an independent instance's writes.
      output.ch(0).at(i).write(y); output.ch(1).at(i).write(zero);
    }); } };
  });
  processors.set(sampleRate, p); return p;
}
function channels(input: Float32Array, hz = 2000, resonance = 0.7, drive = 2) {
  return [input, fill(input.length, hz), fill(input.length, resonance), fill(input.length, drive), fill(input.length)];
}
async function render(rate: number, data: Float32Array[], restore?: Uint8Array) {
  const result = await renderOffline(processor(rate), { sampleRate: rate, duration: (data[0].length - 0.25) / rate, inputs: { main: data }, restore });
  expect(result.outputs.main[0].length).toBe(data[0].length);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  expect(result.outputs.main.every(ch => ch.every(Number.isFinite))).toBe(true);
  expect(peak(result.outputs.main[0])).toBeLessThanOrEqual(0.50000006);
  expect(peak(result.outputs.main[1])).toBe(0);
  return result;
}

for (const rate of rates) {
  test(`character nonlinear recurrence, impulse, step and parameter endpoints at ${rate}`, async () => {
    let maximumError = 0;
    for (const hz of [20, 2000, Math.min(20000, rate / 5)]) for (const resonance of [0, .5, 1]) for (const drive of [0, 1, 16]) {
      const signal = Float32Array.from({ length: 2048 }, (_, i) => i === 0 ? 8 : i > 511 ? -.4 : 0);
      const data = channels(signal, hz, resonance, drive);
      const actual = (await render(rate, data)).outputs.main[0];
      const expected = characterReference(rate, data).output;
      const deviation = error(actual, expected); maximumError = Math.max(maximumError, deviation);
      expect(deviation).toBeLessThan(9e-8);
      if (drive === 0) expect(peak(actual)).toBe(0);
    }
    evidence.push({ check: 'independent nonlinear recurrence', rate, maximumError });
  }, 90000);

  test(`character small-signal transfer, signed phase, DC and Nyquist at ${rate}`, async () => {
    const n = 8192, hz = 2000;
    for (const resonance of [0, .5, 1]) {
      const input = fill(n); input[0] = 1e-5;
      const data = channels(input, hz, resonance, 1);
      const actual = (await render(rate, data)).outputs.main[0];
      const expected = linearReference(input, rate, hz, resonance);
      expect(error(actual, expected)).toBeLessThan(1e-12);
      // Algebraic transform of the impulse must retain signed phase, not only RMS.
      const a = -Math.expm1(-2 * Math.PI * hz / rate), b = 1 - a;
      for (const bin of [0, 73, 351, n / 2]) {
        const w = 2 * Math.PI * bin / n, c = Math.cos(w), s = Math.sin(w);
        let re = 1, im = 0;
        for (let j = 0; j < 4; j++) { const r = re * (1 - b * c) - im * b * s; im = re * b * s + im * (1 - b * c); re = r; }
        re += 4 * resonance * a ** 4 * c; im -= 4 * resonance * a ** 4 * s;
        const denom = re * re + im * im;
        const p = projection(actual, bin), scale = input[0] * 2 / n;
        expect(Math.abs(p.real - scale * a ** 4 * re / denom)).toBeLessThan(2e-14);
        expect(Math.abs(p.imaginary + scale * a ** 4 * im / denom)).toBeLessThan(2e-14);
      }
      expect(error(actual, input)).toBeGreaterThan(9e-6);
    }
  }, 60000);

  test(`character nonlinear DC, odd harmonics and inside-feedback counterexample at ${rate}`, async () => {
    for (const resonance of [0, .8]) for (const level of [-8, -.05, .05, 8]) {
      const data = channels(fill(8192, level), 3000, resonance, 16);
      const output = (await render(rate, data)).outputs.main[0];
      expect(Math.abs(output.at(-1)! - dcReference(level, Math.fround(resonance), 16))).toBeLessThan(7e-8);
    }
    const n = 4096, bin = 17, signal = Float32Array.from({ length: n * 3 }, (_, i) => .7 * Math.sin(2 * Math.PI * bin * i / n));
    const data = channels(signal, 3000, .8, 8), out = (await render(rate, data)).outputs.main[0].slice(-n);
    const reference = characterReference(rate, data).output.slice(-n);
    const postShaped = Float64Array.from(linearReference(signal, rate, 3000, Math.fround(.8), 8).slice(-n), saturation);
    const dc = out.reduce((a, b) => a + b, 0) / n;
    expect(Math.abs(dc)).toBeLessThan(1e-7);
    const h1 = projection(out, bin).amplitude, h2 = projection(out, 2 * bin).amplitude, h3 = projection(out, 3 * bin).amplitude;
    expect(h3 / h1).toBeGreaterThan(.025); expect(h2 / h1).toBeLessThan(1e-5);
    expect(error(out, reference)).toBeLessThan(9e-8);
    expect(error(out, postShaped)).toBeGreaterThan(.1);
    evidence.push({ check: 'nonlinear DC/harmonics', rate, fundamental: h1, second: h2, third: h3, thirdToFundamental: h3 / h1, dc, rejectedPostShaperError: error(out, postShaped) });
  }, 60000);

  test(`character arbitrary-rate automation, full input and control bounds at ${rate}`, async () => {
    const n = 32768;
    const input = Float32Array.from({ length: n }, (_, i) => [8, -8, 3.4028234663852886e38, -3.4028234663852886e38, .2 * Math.sin(i), 0][i % 6]);
    const data = [input,
      Float32Array.from(input, (_, i) => i % 2 ? 20 : i % 31 ? 1e30 : 20 * 1000 ** ((1 + Math.sin(2 * Math.PI * 1000 * i / rate)) / 2)),
      Float32Array.from(input, (_, i) => [-10, 0, .4, 1, 1e30][i % 5]),
      Float32Array.from(input, (_, i) => [-10, 0, .125, 16, 1e30][i % 5]), fill(n)];
    for (const index of [0, 127, 128, 129, 4095, 4096]) data[4][index] = 1;
    const result = await render(rate, data), expected = characterReference(rate, data).output;
    expect(error(result.outputs.main[0], expected)).toBeLessThan(9e-8);
    const clamped = data.map((ch, index) => index === 0 ? ch.map(x => bounded(x, -8, 8, 0)) : index === 1 ? ch.map(x => bounded(x, 20, Math.min(20000, rate / 5), 20)) : index === 2 ? ch.map(x => bounded(x, 0, 1, 0)) : index === 3 ? ch.map(x => bounded(x, 0, 16, 1)) : ch);
    expect((await render(rate, clamped)).outputs.main[0]).toEqual(result.outputs.main[0]);
    const slots = inspect(result.state).slots;
    expect(Object.keys(slots)).toHaveLength(8);
    evidence.push({ check: 'abrupt bounds/automation', rate, frames: n, peak: peak(result.outputs.main[0]), maximumError: error(result.outputs.main[0], expected), scrubs: result.diagnostics.scrubbedSamples });
    // Continuous logarithmic control sweeps as well as adversarial jumps.
    for (const speed of [10, 100, 1000]) {
      const smooth = channels(Float32Array.from(input, (_, i) => .8 * Math.sin(2 * Math.PI * 173 * i / rate)));
      smooth[1] = Float32Array.from(input, (_, i) => 20 * (Math.min(20000, rate / 5) / 20) ** ((1 + Math.sin(2 * Math.PI * speed * i / rate)) / 2));
      smooth[2] = Float32Array.from(input, (_, i) => .5 + .5 * Math.sin(2 * Math.PI * (speed + 7) * i / rate));
      smooth[3] = Float32Array.from(input, (_, i) => 8 + 8 * Math.sin(2 * Math.PI * (speed + 13) * i / rate));
      const y = (await render(rate, smooth)).outputs.main[0];
      expect(error(y, characterReference(rate, smooth).output)).toBeLessThan(9e-8);
    }
  }, 90000);

  test(`character reset, held reset, noninitial snapshot, zero-drive tail and tiny history at ${rate}`, async () => {
    const n = 2048, input = Float32Array.from({ length: n }, (_, i) => .2 * Math.sin(i / 19) + .1);
    const data = channels(input); data[4][129] = 1; data[4].fill(1, 500, 600);
    const whole = await render(rate, data), first = await render(rate, data.map(x => x.slice(0, 1024)));
    const resumed = await render(rate, data.map(x => x.slice(1024)), first.state);
    expect(resumed.outputs.main[0]).toEqual(whole.outputs.main[0].slice(1024));
    expect(resumed.state).toEqual(whole.state);
    const missing = await render(rate, data.map(x => x.slice(1024)));
    expect(error(missing.outputs.main[0], resumed.outputs.main[0])).toBeGreaterThan(.01);
    const expected = characterReference(rate, data).output;
    expect(error(whole.outputs.main[0], expected)).toBeLessThan(9e-8);
    const cleared = channels(fill(128), 2000, 1, 0); cleared[4][0] = 1;
    expect(peak((await render(rate, cleared, first.state)).outputs.main[0])).toBe(0);
    const tail = await render(rate, channels(fill(128), 2000, .7, 0), first.state);
    expect(peak(tail.outputs.main[0])).toBeGreaterThan(.001);
    for (const level of [1e-35, 1e-39, 2 ** -149]) {
      const tiny = channels(fill(4096, level), 2000, .5, 16);
      const y = await render(rate, tiny), oracle = characterReference(rate, tiny).output;
      expect(error(y.outputs.main[0], oracle)).toBeLessThanOrEqual(Math.max(2 ** -149, level * 2e-6));
      expect(y.outputs.main[0].at(-1)).toBeGreaterThan(0);
      const prefix = await render(rate, tiny.map(x => x.slice(0, 2048)));
      expect((await render(rate, tiny.map(x => x.slice(2048)), prefix.state)).outputs.main[0]).toEqual(y.outputs.main[0].slice(2048));
    }
  }, 60000);

  test(`character base-rate folded energy is measured and is not alias-free at ${rate}`, async () => {
    const n = 4096, bin = 997;
    const input = Float32Array.from({ length: n * 3 }, (_, i) => 2 * Math.sin(2 * Math.PI * bin * i / n));
    const data = channels(input, rate / 5, .7, 16);
    const output = (await render(rate, data)).outputs.main[0].slice(-n);
    const alias = foldedResidual(output, bin), referenceAlias = foldedResidual(characterReference(rate, data).output.slice(-n), bin);
    expect(alias).toBeGreaterThan(1e-4);
    expect(Math.abs(alias - referenceAlias)).toBeLessThan(9e-8);
    evidence.push({ check: 'base-rate alias boundary', rate, frames: n, inputBin: bin, inputLevel: 2, poleHz: rate / 5, resonance: .7, drive: 16, foldedRms: alias, foldedDbfs: 20 * Math.log10(alias), fundamental: projection(output, bin).amplitude, peak: peak(output) });
  }, 60000);
}

test('character repairs nonfinite audio/controls without output scrub or sticky poisoned history', async () => {
  const values = [NaN, Infinity, -Infinity, 0, 1, -1];
  const data = Array.from({ length: 5 }, (_, ch) => Float32Array.from({ length: 1024 }, (_, i) => ch === 4 ? 0 : i > 512 ? [.25, 2000, .5, 2][ch] : values[(Math.floor(i / 17) + ch) % values.length]));
  const result = await render(48000, data);
  expect(error(result.outputs.main[0], characterReference(48000, data).output)).toBeLessThan(9e-8);
  expect(Math.abs(result.outputs.main[0].at(-1)! - dcReference(.25, .5, 2))).toBeLessThan(1e-6);
});

test('character fixed four-slot cost, native sqrt precision and construction-rate endpoints', async () => {
  for (const rate of [8000, 192000]) {
    const data = channels(Float32Array.from({ length: 1024 }, (_, i) => 8 * Math.sin(i)), rate / 5, 1, 16);
    expect(error((await render(rate, data)).outputs.main[0], characterReference(rate, data).output)).toBeLessThan(9e-8);
  }
  for (const rate of [NaN, Infinity, -1, 0, 7999, 192001]) expect(() => processor(rate)).toThrow(/sampleRate/);
  const start = performance.now(), compiled = await compile(processor(48000), { sampleRate: 48000 });
  expect(compiled.wasm.byteLength).toBeLessThan(24000);
  evidence.push({ check: 'two-instance compiled cost', wasmBytes: compiled.wasm.byteLength, compileWallMs: performance.now() - start, stateSlots: 8, realtimeClearance: false });
});
