import { test, expect } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate, f32, type Node } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { delayFx, type DelayFxConfig, type DelayFxControls } from '../src/delay-fx.js';

const rates = [44100, 48000, 96000];
const keys = ['timeLeftSeconds', 'timeRightSeconds', 'sync', 'bpm', 'beatsLeft', 'beatsRight', 'feedback', 'cutoffHz', 'mix', 'rateHz', 'depthSeconds', 'bypass', 'reset'] as const;
type Key = typeof keys[number];
type Values = Record<Key, number>;
type Edits = Partial<Record<Key, number | ((n: number) => number)>>;
type Config = Omit<DelayFxConfig, 'sampleRate'> & { capacitySamples?: number };
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
function fixture(config: Config, isolation = false) {
  return defineProcessor(ctx => {
    const input = audioInput({ channels: 2, name: 'main' });
    const controls = audioInput({ channels: keys.length, name: 'controls' });
    const output = audioOutput({ channels: isolation ? 6 : 4, name: 'main' });
    const engine = instantiate(delayFx, { ...config, sampleRate: ctx.sampleRate, maxDelaySeconds: config.capacitySamples === undefined ? config.maxDelaySeconds : config.capacitySamples / ctx.sampleRate }, { name: 'engine' });
    const other = isolation ? instantiate(delayFx, { ...config, sampleRate: ctx.sampleRate, maxDelaySeconds: config.capacitySamples === undefined ? config.maxDelaySeconds : config.capacitySamples / ctx.sampleRate }, { name: 'other' }) : null;
    return { process() { forSample(i => {
      const c = Object.fromEntries(keys.map((key, k) => [key, ['sync', 'reset', 'bypass'].includes(key) ? controls.ch(k).at(i).gt(0.5) : controls.ch(k).at(i)])) as unknown as DelayFxControls;
      const result = engine.tick(input.ch(0).at(i), input.ch(1).at(i), c);
      output.ch(0).at(i).write(result.left); output.ch(1).at(i).write(result.right);
      output.ch(2).at(i).write(f32(result.timingRejected)); output.ch(3).at(i).write(f32(result.modulationClipped));
      if (other) {
        const isolated = other.tick(f32(0), f32(0), c);
        output.ch(4).at(i).write(isolated.left); output.ch(5).at(i).write(isolated.right);
      }
    }); } };
  });
}
function inputs(rate: number, edits: Edits = {}, size = 512, left = (n: number) => n === 0 ? 1 : 0, right = (_n: number) => 0) {
  const defaults: Values = { timeLeftSeconds: 8 / rate, timeRightSeconds: 12 / rate, sync: 0, bpm: 120, beatsLeft: 1, beatsRight: 1.5, feedback: 0.5, cutoffHz: 1000, mix: 1, rateHz: 0, depthSeconds: 0, bypass: 0, reset: 0 };
  const rows = Array.from({ length: size }, (_, n) => Object.fromEntries(keys.map(key => [key, Math.fround(typeof edits[key] === 'function' ? (edits[key] as (n: number) => number)(n) : edits[key] ?? defaults[key])])) as Values);
  const audio = [Float32Array.from({ length: size }, (_, n) => left(n)), Float32Array.from({ length: size }, (_, n) => right(n))];
  return { rows, audio, ports: { main: audio, controls: keys.map(key => Float32Array.from(rows, row => row[key])) } };
}
async function render(rate: number, config: Config, data: ReturnType<typeof inputs>, isolation = false, restore?: Uint8Array) {
  const result = await renderOffline(fixture(config, isolation), { sampleRate: rate, duration: data.rows.length / rate, inputs: data.ports, restore });
  expect(result.outputs.main[0].length).toBe(data.rows.length);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  return result;
}
function close(actual: Float32Array, expected: ArrayLike<number>, tolerance = 3e-6) {
  expect(actual.length).toBe(expected.length);
  let worst = 0, index = 0;
  for (let n = 0; n < actual.length; n++) {
    if (!Number.isFinite(actual[n])) throw new Error(`nonfinite sample ${n}`);
    const error = Math.abs(actual[n] - expected[n]);
    if (error > worst) { worst = error; index = n; }
  }
  expect(worst, `sample ${index}, actual=${actual[index]}, expected=${expected[index]}`).toBeLessThanOrEqual(tolerance);
}
// Unbounded written timeline, no circular indices or readhead implementation.
// Static tone uses a direct-form bilinear biquad (not the SVF recurrence).
// Variable tone uses two trapezoidal one-poles in cascade, alternate state
// coordinates p=SVF band+low and q=SVF low, independently evaluated with Math.tan.
function reference(rate: number, config: Config, data: ReturnType<typeof inputs>, variableTone = false) {
  const maximum = config.maxDelaySeconds ?? 8, minimum = Math.fround(1 / rate);
  const written = [[], []] as number[][], out = Array.from({ length: 4 }, () => new Float32Array(data.rows.length));
  const previous = [minimum, minimum], phase = [0, config.stereoPhaseCycles ?? 0.5];
  const filters = Array.from({ length: 2 }, () => ({ x1: 0, x2: 0, y1: 0, y2: 0, p: 0, q: 0 }));
  let start = 0;
  for (let n = 0; n < data.rows.length; n++) {
    const c = data.rows[n], reset = c.reset > 0.5;
    if (reset) start = n;
    const requested = c.sync > 0.5 ? [c.beatsLeft, c.beatsRight].map(b => Math.fround(60 * b / clamp(c.bpm, 30, 300))) : [c.timeLeftSeconds, c.timeRightSeconds];
    const within = (x: number) => x >= minimum && x <= Math.fround(maximum);
    const valid = requested.every(within) && (c.sync <= 0.5 || (c.bpm >= 30 && c.bpm <= 300));
    out[2][n] = valid ? 0 : 1;
    for (let ch = 0; ch < 2; ch++) {
      if (reset || n === 0) phase[ch] = ch === 0 ? 0 : (config.stereoPhaseCycles ?? 0.5) % 1;
      const signal = Math.fround(Math.sin(2 * Math.PI * phase[ch]));
      phase[ch] = (phase[ch] + clamp(c.rateHz, 0, 20) / rate) % 1;
      const base = valid ? requested[ch] : reset ? minimum : previous[ch]; previous[ch] = base;
      const raw = Math.fround(base + Math.fround(signal * clamp(c.depthSeconds, 0, 0.05)));
      if (!within(raw)) out[3][n] = 1;
      const delay = clamp(clamp(raw, minimum, Math.fround(maximum)) * rate, 1, maximum * rate);
      const at = n - delay, lower = Math.floor(at), fraction = at - lower;
      const sample = (index: number) => index >= start && index < n ? written[ch][index] : 0;
      const wet = Math.fround(sample(lower) * (1 - fraction) + sample(lower + 1) * fraction);
      const s = filters[ch];
      if (reset) Object.assign(s, { x1: 0, x2: 0, y1: 0, y2: 0, p: 0, q: 0 });
      const g = Math.tan(Math.PI * clamp(c.cutoffHz, 20, Math.min(20000, 0.24 * rate)) / rate);
      const norm = 1 / (1 + 2 * g + g * g), b0 = g * g * norm;
      let filtered;
      if (variableTone) {
        const u = (s.p + g * wet) / (1 + g), v = (s.q + g * u) / (1 + g);
        s.p = 2 * u - s.p; s.q = 2 * v - s.q; filtered = Math.fround(v);
      } else {
        const y = b0 * (wet + 2 * s.x1 + s.x2) - 2 * (g * g - 1) * norm * s.y1 - (1 - 2 * g + g * g) * norm * s.y2;
        s.x2 = s.x1; s.x1 = wet; s.y2 = s.y1; s.y1 = y; filtered = Math.fround(y);
      }
      const dryOnly = !valid || c.bypass > 0.5;
      const feedback = Math.fround((config.tone === 'flat' ? wet : filtered) * Math.fround(clamp(c.feedback, 0, 0.95)));
      written[ch][n] = Math.fround((dryOnly ? 0 : data.audio[ch][n]) + feedback);
      const mix = clamp(c.mix, 0, 1);
      out[ch][n] = dryOnly ? data.audio[ch][n] : data.audio[ch][n] * (1 - mix) + wet * mix;
    }
  }
  return out;
}

for (const rate of rates) {
  test(`flat feedback has correct impulse spacing/amplitude and stereo isolation at ${rate}`, async () => {
    // Power-of-two sample rate fractions are not assumed: oracle accounts for f32 seconds.
    const config = { maxDelaySeconds: 32 / rate, tone: 'flat' as const };
    for (const gain of [0, 0.5, 0.95, -1, 2]) {
      const data = inputs(rate, { feedback: gain });
      const result = await render(rate, config, data, true);
      const expected = reference(rate, config, data);
      result.outputs.main.slice(0, 4).forEach((a, ch) => close(a, expected[ch]));
      expect(result.outputs.main[1].every(x => x === 0)).toBe(true);
      expect(result.outputs.main.slice(4).every(a => a.every(x => x === 0))).toBe(true);
      expect(() => close(result.outputs.main[0], expected[0].slice().reverse())).toThrow();
    }
    // Exact one-sample capacity removes seconds rounding; feedback must not add latency.
    const one = await render(rate, { capacitySamples: 1, tone: 'flat' }, inputs(rate, { timeLeftSeconds: 1 / rate, timeRightSeconds: 1 / rate }));
    close(one.outputs.main[0].slice(0, 6), [0, 1, 0.5, 0.25, 0.125, 0.0625], 0);
  });
  test(`feedback tone matches independent biquad including reset and restart at ${rate}`, async () => {
    for (const cutoff of [20, 1000, rate]) {
      const config = { maxDelaySeconds: 32 / rate };
      const data = inputs(rate, { cutoffHz: cutoff, feedback: 0.9, reset: n => n === 127 ? 1 : 0 }, 1024, n => n === 0 || n === 127 || n === 400 ? 1 : 0, n => n === 40 ? -0.5 : 0);
      const result = await render(rate, config, data);
      const expected = reference(rate, config, data);
      result.outputs.main.forEach((a, ch) => close(a, expected[ch]));
      expect(result.outputs.main[0][127]).toBe(0);
    }
  });
  test(`bypass preserves internal decay, blocks new input, and reset cannot revive tail at ${rate}`, async () => {
    const config = { maxDelaySeconds: 32 / rate, tone: 'flat' as const };
    const data = inputs(rate, { bypass: n => n >= 32 && n < 128 ? 1 : 0, reset: n => n >= 200 && n < 208 ? 1 : 0 }, 512, n => n === 0 || n === 64 || n === 256 ? 1 : 0);
    const result = await render(rate, config, data);
    close(result.outputs.main[0], reference(rate, config, data)[0]);
    expect(result.outputs.main[0][64]).toBe(1); // Unity dry, never added to history.
    expect(result.outputs.main[0].slice(128, 200).some(x => x > 0)).toBe(true);
    expect(result.outputs.main[0].slice(200, 256).every(x => x === 0)).toBe(true);
  });
  test(`linear mix endpoints and mono duplication at ${rate}`, async () => {
    const config = { maxDelaySeconds: 32 / rate, tone: 'flat' as const, stereoPhaseCycles: 0 };
    for (const mix of [-1, 0, 0.25, 1, 2]) {
      const source = (n: number) => Math.sin(n * 0.15) * 0.25;
      const data = inputs(rate, { mix, timeRightSeconds: 8 / rate }, 512, source, source);
      const result = await render(rate, config, data);
      close(result.outputs.main[0], reference(rate, config, data)[0]);
      close(result.outputs.main[0], result.outputs.main[1], 0);
      if (mix <= 0) close(result.outputs.main[0], data.audio[0], 0);
    }
  });
  test(`tempo grids, immediate tempo changes and rejected requests preserve previous internal time at ${rate}`, async () => {
    const config = { maxDelaySeconds: 0.1, tone: 'flat' as const };
    const data = inputs(rate, { sync: 1, bpm: n => n < 128 ? 120 : n < 256 ? 240 : n < 384 ? 10 : 120, beatsLeft: 0.0625, beatsRight: 0.09375, feedback: 0.7 }, 8192);
    const result = await render(rate, config, data);
    const expected = reference(rate, config, data);
    result.outputs.main.forEach((a, ch) => close(a, expected[ch]));
    expect(result.outputs.main[2].slice(256, 384).every(x => x === 1)).toBe(true);
    const tooLong = inputs(rate, { sync: 1, bpm: 30, beatsLeft: 4, beatsRight: 4 }, 128, () => 0.25, () => -0.5);
    const rejected = await render(rate, config, tooLong);
    close(rejected.outputs.main[0], tooLong.audio[0], 0);
    expect(rejected.outputs.main[2].every(x => x === 1)).toBe(true);
    const accepted = await render(rate, {}, tooLong);
    expect(accepted.outputs.main[2].every(x => x === 0)).toBe(true); // Default covers an eight-second whole note.
  });
  test(`chorus modulation and clipping match the moving-head reference at ${rate}`, async () => {
    const config = { maxDelaySeconds: 32 / rate, tone: 'flat' as const };
    const source = (n: number) => Math.sin(2 * Math.PI * 440 * n / rate) * 0.2;
    const data = inputs(rate, { feedback: 0, rateHz: 20, depthSeconds: 20 / rate, mix: 0.5, reset: n => n === 1024 ? 1 : 0 }, 2048, source, source);
    const result = await render(rate, config, data);
    const expected = reference(rate, config, data);
    result.outputs.main.forEach((a, ch) => close(a, expected[ch], 4e-6));
    expect(result.outputs.main[3].some(x => x === 1)).toBe(true);
    expect(result.outputs.main[0].some((x, n) => Math.abs(x - result.outputs.main[1][n]) > 1e-3)).toBe(true);
  });
}

for (const rate of rates) {
  test(`rapid cutoff/time/gain modulation remains bounded with independent cascade reference at ${rate}`, async () => {
    const config = { maxDelaySeconds: 64 / rate };
    const data = inputs(rate, { feedback: n => n % 3 === 0 ? 2 : 0.9, cutoffHz: n => n % 2 ? 20 : rate,
      timeLeftSeconds: n => (n % 3 === 0 ? 1 : 31.75) / rate, timeRightSeconds: n => (n % 5 === 0 ? 1.5 : 64) / rate,
      rateHz: 0, depthSeconds: 0 }, 8192, n => n < 4096 ? Math.sin(n * 1.7) : 0, n => n < 4096 ? Math.cos(n * 0.15) : 0);
    const result = await render(rate, config, data);
    const expected = reference(rate, config, data, true);
    result.outputs.main.forEach((a, ch) => close(a, expected[ch], 4e-6));
    for (const a of result.outputs.main.slice(0, 2)) expect(a.every(x => Math.abs(x) <= 20.00001)).toBe(true);
  });
  test(`long tail decays at minimum cutoff and maximum gain at ${rate}`, async () => {
    const size = 2 ** 20, config = { maxDelaySeconds: 0.005 };
    const data = inputs(rate, { feedback: 0.95, cutoffHz: 20, timeLeftSeconds: 0.005, timeRightSeconds: 0.004 }, size);
    const result = await render(rate, config, data);
    const audio = result.outputs.main[0];
    expect(audio.every(x => Number.isFinite(x) && x >= -1e-6 && x <= 1.000001)).toBe(true);
    expect(Math.max(...audio.slice(-1024).map(Math.abs))).toBeLessThan(1e-6);
    const early = audio.slice(1024, 2048).reduce((s, x) => s + x * x, 0);
    const late = audio.slice(-1024).reduce((s, x) => s + x * x, 0);
    expect(late).toBeLessThan(early * 1e-6);
  }, 30000);
  test(`same-schema continuation and fresh instances do not carry engine state at ${rate}`, async () => {
    const config = { maxDelaySeconds: 64 / rate };
    const a = inputs(rate, { rateHz: 5, depthSeconds: 4 / rate, feedback: 0.9 });
    const first = await render(rate, config, a);
    const b = inputs(rate, { rateHz: 5, depthSeconds: 4 / rate, feedback: 0.9 }, 512, () => 0);
    const resumed = await render(rate, config, b, false, first.state);
    const full = inputs(rate, { rateHz: 5, depthSeconds: 4 / rate, feedback: 0.9 }, 1024);
    const continuous = await render(rate, config, full);
    resumed.outputs.main.forEach((x, ch) => close(x, continuous.outputs.main[ch].slice(512), 0));
    const fresh = await render(rate, config, b);
    expect(fresh.outputs.main.slice(0, 2).every(x => x.every(v => v === 0))).toBe(true);
    const reset = inputs(rate, { rateHz: 5, depthSeconds: 4 / rate, feedback: 0.9, reset: n => n === 0 ? 1 : 0 }, 512, () => 0);
    const cleared = await render(rate, config, reset, false, first.state);
    expect(cleared.outputs.main.slice(0, 2).every(x => x.every(v => v === 0))).toBe(true);
  });
}

test('time/mix/bypass steps have explicit discontinuities while bounded chorus is continuous', async () => {
  const rate = 48000, config = { maxDelaySeconds: 32 / rate, tone: 'flat' as const };
  const source = (n: number) => n / 512;
  for (const edits of [
    { timeLeftSeconds: (n: number) => (n < 128 ? 4 : 12) / rate },
    { mix: (n: number) => n < 128 ? 0 : 1 },
    { bypass: (n: number) => n < 128 ? 1 : 0 },
  ]) {
    const data = inputs(rate, { feedback: 0, ...edits }, 512, source, source);
    const result = await render(rate, config, data);
    close(result.outputs.main[0], reference(rate, config, data)[0]);
    expect(Math.abs(result.outputs.main[0][128] - result.outputs.main[0][127])).toBeGreaterThan(1 / 512);
  }
  const rateHz = 2, depth = 4 / rate, frequency = 220;
  const data = inputs(rate, { feedback: 0, rateHz, depthSeconds: depth }, 8192, n => Math.sin(2 * Math.PI * frequency * n / rate));
  const result = await render(rate, config, data);
  let largestStep = 0;
  for (let n = 33; n < 8192; n++) largestStep = Math.max(largestStep, Math.abs(result.outputs.main[0][n] - result.outputs.main[0][n - 1]));
  // Source slope * (1 + maximum delay slope), plus interpolation/rounding margin.
  expect(largestStep).toBeLessThan(2 * Math.PI * frequency / rate * (1 + 2 * Math.PI * rateHz * depth) + 2e-5);
});

test('maximum-depth/rate modulation at maximum feedback obeys the common amplitude bound', async () => {
  for (const rate of rates) {
    const data = inputs(rate, { feedback: 0.95, cutoffHz: n => n % 2 ? 20 : rate,
      rateHz: 20, depthSeconds: 0.05, timeLeftSeconds: 0.01, timeRightSeconds: 0.02 }, 65536,
      n => n < 32768 ? 0.25 * Math.sin(n * 1.7) : 0, n => n < 32768 ? 0.25 * Math.cos(n * 0.7) : 0);
    const result = await render(rate, { maxDelaySeconds: 0.06 }, data);
    for (const a of result.outputs.main.slice(0, 2)) expect(a.every(x => Number.isFinite(x) && Math.abs(x) <= 5.00001)).toBe(true);
    expect(result.outputs.main[3].some(x => x === 1)).toBe(true);
  }
}, 15000);

test('maximum feedback has unity-DC accumulation without hidden normalization; invalid base time is explicit', async () => {
  const rate = 48000;
  const data = inputs(rate, { timeLeftSeconds: 1 / rate, timeRightSeconds: 1 / rate, feedback: 2, cutoffHz: rate }, 4096, () => 1, () => -1);
  const result = await render(rate, { capacitySamples: 1 }, data);
  expect(Math.abs(result.outputs.main[0][4095] - 20)).toBeLessThan(1e-4);
  expect(Math.abs(result.outputs.main[1][4095] + 20)).toBeLessThan(1e-4);
  const invalid = inputs(rate, { timeLeftSeconds: n => n < 128 ? 0 : -1, timeRightSeconds: 1 / rate }, 256, () => 0.125, () => -0.25);
  const rejected = await render(rate, { maxDelaySeconds: 0.1 }, invalid);
  close(rejected.outputs.main[0], invalid.audio[0], 0); close(rejected.outputs.main[1], invalid.audio[1], 0);
  expect(rejected.outputs.main[2].every(x => x === 1)).toBe(true);
});

test('fixed quarter-note fractions repeat on the exact stereo rhythmic grid', async () => {
  const rate = 48000, size = 8192;
  const data = inputs(rate, { sync: 1, bpm: 120, beatsLeft: 0.0625, beatsRight: 0.09375 }, size, n => n === 0 ? 1 : 0, n => n === 0 ? 1 : 0);
  const result = await render(rate, { maxDelaySeconds: 0.1, tone: 'flat' }, data);
  for (const [ch, period] of [[0, 1500], [1, 2250]]) {
    const expected = Float32Array.from({ length: size }, (_, n) => n > 0 && n % period === 0 ? 0.5 ** (n / period - 1) : 0);
    close(result.outputs.main[ch], expected, 0);
  }
});
