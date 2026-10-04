import { test, expect } from 'vitest';
import { chorusSettings, rhythmicDelaySettings } from '../src/delay-settings.js';
import { inputs, render, reference, close } from './fixtures/delay-settings.mjs';

const rates = [44100, 48000, 96000];
const settings = [chorusSettings, rhythmicDelaySettings];
const numeric = (values: Record<string, number | boolean>) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)]));
const frames = (rate: number) => 2 ** Math.ceil(Math.log2(rate * 2));
const compare = (actual: Float32Array[], expected: Float32Array[], tolerance = 5e-6) => actual.forEach((a, ch) => close(a, expected[ch], ch < 2 ? tolerance : 0));

for (const rate of rates) {
  for (const [index, setting] of settings.entries()) {
    const name = index === 0 ? 'chorus' : 'rhythmic delay';
    test(`${name} fixed mono source, phase, tail and independent oracle at ${rate}`, async () => {
      const source = (n: number) => n < rate / 2 ? Math.sin(2 * Math.PI * 220 * n / rate) * 0.2 : 0;
      const data = inputs(rate, numeric(setting.parameters), frames(rate), source, source);
      const result = await render(rate, setting.config, data, true);
      const expected = reference(rate, setting.config, data);
      compare(result.outputs.main.slice(0, 4), expected);
      expect(result.outputs.main.slice(4).every((a: Float32Array) => a.every(x => x === 0))).toBe(true);
      expect(result.outputs.main[2].every((x: number) => x === 0)).toBe(true);
      expect(result.outputs.main[3].every((x: number) => x === 0)).toBe(true);
      expect(result.outputs.main[0].some((x: number, n: number) => Math.abs(x - result.outputs.main[1][n]) > 1e-3)).toBe(true);
      expect(result.outputs.main[0].slice(rate / 2, rate).some((x: number) => Math.abs(x) > 1e-3)).toBe(true);
      if (index === 0) expect(result.outputs.main[0].slice(rate).every((x: number) => x === 0)).toBe(true);
      else expect(result.outputs.main[0].slice(rate, rate * 2).some((x: number) => Math.abs(x) > 1e-4)).toBe(true);
      // A shifted expected signal must fail; generated audio is never the oracle.
      expect(() => close(result.outputs.main[0], Float32Array.from(expected[0], (_, n) => expected[0][(n + 17) % expected[0].length]), 5e-6)).toThrow();
    }, 30000);

    test(`${name} abrupt edits, rejected tempo/capacity, bypass and reset at ${rate}`, async () => {
      const q = Math.floor(rate / 4), end = frames(rate);
      const data = inputs(rate, {
        ...numeric(setting.parameters),
        rateHz: (n: number) => n < q ? setting.parameters.rateHz : 4,
        depthSeconds: (n: number) => n < q ? setting.parameters.depthSeconds : 0.05,
        timeLeftSeconds: (n: number) => n < 2 * q ? setting.parameters.timeLeftSeconds : 0.001,
        bpm: (n: number) => n < q ? 120 : n < 2 * q ? 240 : n < 3 * q ? 20 : 120,
        beatsRight: (n: number) => n >= 3 * q && n < 4 * q ? 8 : 1,
        bypass: (n: number) => n >= 4 * q && n < 5 * q ? 1 : 0,
        reset: (n: number) => n === 6 * q ? 1 : 0,
      }, end, (n: number) => n < 4 * q ? Math.sin(n * 0.17) * 0.1 : n === 4 * q + 7 ? 0.75 : 0);
      const result = await render(rate, setting.config, data);
      // Math.sin and the bounded polynomial can straddle a float rounding tie.
      // One delay-time ULP then moves the read position by rate*ULP samples.
      // Budget two such ULPs using this source's maximum adjacent slope;
      // the positive feedback filter has unity DC gain. Keep status bits exact.
      const largestTime = index === 0 ? 0.018 + 0.05 : 0.5 + 0.05;
      const timeUlp = 2 ** (Math.floor(Math.log2(largestTime)) - 23);
      const slope = 2 * 0.1 * Math.sin(0.17 / 2);
      const roundingBudget = 2e-6 + 2 * timeUlp * rate * slope * setting.parameters.mix / (1 - setting.parameters.feedback) ** 2;
      compare(result.outputs.main, reference(rate, setting.config, data), roundingBudget);
      expect(result.outputs.main[0][4 * q + 7]).toBe(0.75);
      expect(result.outputs.main[0].slice(6 * q).every((x: number) => x === 0)).toBe(true);
      if (index === 0) expect(result.outputs.main[3].some((x: number) => x === 1)).toBe(true);
      else expect(result.outputs.main[2].slice(2 * q, 4 * q).every((x: number) => x === 1)).toBe(true);
    }, 30000);
  }

  test(`chorus exact zero-depth mono, rate/depth movement and opposite phase at ${rate}`, async () => {
    const source = (n: number) => n / (rate * 8);
    const data = inputs(rate, { ...numeric(chorusSettings.parameters), mix: 1 }, frames(rate), source, source);
    const moving = await render(rate, chorusSettings.config, data);
    // On a ramp the fractional-delay interpolation has a closed form. Inspect
    // a quarter LFO cycle after history fills: +/-3ms at 0.65Hz.
    const n = Math.round(rate / (4 * 0.65));
    const phase = Math.fround(0.65) * n / rate;
    for (const ch of [0, 1]) {
      const delay = 0.018 + 0.003 * Math.sin(2 * Math.PI * (phase + ch * 0.5));
      expect(moving.outputs.main[ch][n]).toBeCloseTo((n - delay * rate) / (rate * 8), 6);
    }
    const mono = inputs(rate, { ...numeric(chorusSettings.parameters), depthSeconds: 0 }, 4096, source, source);
    const staticResult = await render(rate, chorusSettings.config, mono);
    close(staticResult.outputs.main[0], staticResult.outputs.main[1], 0);
    const samePhase = await render(rate, { ...chorusSettings.config, stereoPhaseCycles: 0 }, data);
    close(samePhase.outputs.main[0], samePhase.outputs.main[1], 0);
  }, 30000);

  test(`rhythmic impulse grid and filtered repeats at ${rate}`, async () => {
    const data = inputs(rate, { ...numeric(rhythmicDelaySettings.parameters), mix: 1 }, frames(rate), (n: number) => n === 0 ? 1 : 0, (n: number) => n === 0 ? 1 : 0);
    const result = await render(rate, rhythmicDelaySettings.config, data);
    compare(result.outputs.main, reference(rate, rhythmicDelaySettings.config, data));
    for (const [ch, seconds] of [0.375, 0.5].entries()) {
      const sample = seconds * rate, lower = Math.floor(sample), frac = sample - lower;
      expect(result.outputs.main[ch][lower]).toBeCloseTo(1 - frac, 6);
      if (frac) expect(result.outputs.main[ch][lower + 1]).toBeCloseTo(frac, 6);
      // Complete second echo area is feedback gain, with a low-pass impulse spread.
      // Two fractional reads can begin at twice the earlier tap.
      const second = 2 * Math.floor(sample);
      const area = result.outputs.main[ch].slice(second, second + Math.floor(rate * 0.02)).reduce((a: number, b: number) => a + b, 0);
      expect(area).toBeCloseTo(0.48, 5);
    }
  }, 30000);
}
