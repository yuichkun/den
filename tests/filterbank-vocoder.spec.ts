import { expect, test } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate, inspect } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { filterBankVocoder, type FilterBankVocoderConfig, type FilterBankVocoderBand } from '../src/filterbank-vocoder.js';
// @ts-expect-error The packed-consumer oracle is plain JavaScript, independent of production types.
import { reference, magnitude, maxError, rms, mean, signal } from './filterbank-vocoder-consumer/oracle.mjs';
const rates = [44100, 48000, 96000], fill = (n: number, x = 0) => new Float32Array(n).fill(x);
const bands = [{ frequencyHz: 300, q: 4, gain: .5 }, { frequencyHz: 1000, q: 6, gain: 1 }, { frequencyHz: 3500, q: 4, gain: .8 }];
const cache = new Map<string, ReturnType<typeof defineProcessor>>();
function processor(config: FilterBankVocoderConfig, twins = false) {
  const key = JSON.stringify([config, twins]); if (cache.has(key)) return cache.get(key)!;
  const result = defineProcessor(() => {
    const input = audioInput({ name: 'main', channels: 5 }), output = audioOutput({ name: 'main', channels: config.bands.length + (twins ? 2 : 1) });
    const unit = instantiate(filterBankVocoder, config, { name: 'unit' });
    const other = twins ? instantiate(filterBankVocoder, config, { name: 'other' }) : undefined;
    return { process() { forSample(i => {
      const controls = { attack: input.ch(2).at(i), release: input.ch(3).at(i), reset: input.ch(4).at(i).gt(0) };
      const result = unit.tick(input.ch(0).at(i), input.ch(1).at(i), controls);
      [result.output, ...result.envelopes].forEach((x, ch) => output.ch(ch).at(i).write(x));
      if (other) output.ch(config.bands.length + 1).at(i).write(other.tick(input.ch(0).at(i).mul(0), input.ch(1).at(i), controls).output);
    }); } };
  }); cache.set(key, result); return result;
}
async function render(config: FilterBankVocoderConfig, inputs: Float32Array[], restore?: Uint8Array, twins = false) {
  const result = await renderOffline(processor(config, twins), { sampleRate: config.sampleRate, duration: (inputs[0].length - .25) / config.sampleRate, inputs: { main: inputs }, restore });
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  expect(result.outputs.main[0].length).toBe(inputs[0].length);
  for (const channel of result.outputs.main) expect(channel.every(Number.isFinite)).toBe(true);
  return result;
}
for (const rate of rates) {
  test(`independent dual-bank and exponential envelope oracle, edits/resets at ${rate}`, async () => {
    const config = { sampleRate: rate, bands }, inputs = signal(rate);
    const actual = await render(config, inputs), expected = reference(config, inputs);
    actual.outputs.main.forEach((channel, i) => expect(maxError(channel, expected[i])).toBeLessThan(3e-6));
    expect(rms(actual.outputs.main[0])).toBeGreaterThan(.0001);
  });
  test(`unity-center bank, rectified calibration and out-of-band rejection at ${rate}`, async () => {
    const band = { frequencyHz: 1000, q: 4, gain: 1 }, config = { sampleRate: rate, bands: [band] }, n = Math.ceil(rate * .4 / 128) * 128, settledStart = n - Math.round(rate * .2);
    // The settled half-window is exactly .2 s: integer cycles at every probed frequency.
    // A non-integer window confounds bandpass phase with RMS magnitude.
    const sine = (hz: number) => Float32Array.from({ length: n }, (_, i) => .75 * Math.sin(2 * Math.PI * hz * i / rate));
    const center = await render(config, [sine(1000), sine(1000), fill(n), fill(n), fill(n)]);
    expect(rms(center.outputs.main[1], settledStart) / rms(sine(1000), settledStart)).toBeCloseTo(1, 4);
    expect(magnitude(rate, band, 1000)).toBeCloseTo(1, 12);
    for (const hz of [125, 8000]) {
      const modulated = await render(config, [sine(hz), sine(1000), fill(n), fill(n), fill(n)]);
      const ratio = rms(modulated.outputs.main[1], settledStart) / rms(sine(hz), settledStart);
      expect(Math.abs(ratio - magnitude(rate, band, hz))).toBeLessThan(.0001); expect(ratio).toBeLessThan(.04);
      const rejected = await render(config, [sine(1000), sine(hz), fill(n, .003), fill(n, .003), fill(n)]);
      const passed = await render(config, [sine(1000), sine(1000), fill(n, .003), fill(n, .003), fill(n)]);
      expect(rms(rejected.outputs.main[0], settledStart) / rms(passed.outputs.main[0], settledStart)).toBeLessThan(.04);
      expect(Math.abs(mean(passed.outputs.main[1], settledStart) - .75 * 2 / Math.PI)).toBeLessThan(.0015);
    }
    for (const endpoint of [fill(n, .75), Float32Array.from({ length: n }, (_, i) => i % 2 ? -.75 : .75)]) {
      const rejected = await render(config, [sine(1000), endpoint, fill(n, .003), fill(n, .003), fill(n)]);
      expect(rms(rejected.outputs.main[0], settledStart)).toBeLessThan(1e-8);
    }
  });
  test(`actual carrier modulation and modulator scaling without normalization at ${rate}`, async () => {
    const config = { sampleRate: rate, bands }, n = 8192;
    const modulator = Float32Array.from({ length: n }, (_, i) => i < 4096 ? .4 * Math.sin(2 * Math.PI * 1000 * i / rate) : 0);
    const carrier = Float32Array.from({ length: n }, (_, i) => .6 * Math.sin(2 * Math.PI * 1000 * i / rate));
    const inputs = [modulator, carrier, fill(n, .001), fill(n, .002), fill(n)];
    const original = await render(config, inputs);
    const doubled = await render(config, [Float32Array.from(modulator, x => x * 2), carrier, ...inputs.slice(2)]);
    expect(maxError(doubled.outputs.main[0], Float32Array.from(original.outputs.main[0], x => x * 2))).toBeLessThan(1e-7);
    const inverted = await render(config, [modulator, Float32Array.from(carrier, x => -x), ...inputs.slice(2)]);
    expect(maxError(inverted.outputs.main[0], Float32Array.from(original.outputs.main[0], x => -x))).toBe(0);
    for (const pair of [[fill(n), carrier], [modulator, fill(n)]]) {
      const silent = await render(config, [...pair, ...inputs.slice(2)]); expect(rms(silent.outputs.main[0])).toBe(0);
    }
    expect(rms(original.outputs.main[0], 7000)).toBeLessThan(1e-5);
    const gain4 = await render({ sampleRate: rate, bands: bands.map(b => ({ ...b, gain: b.gain * 4 })) }, inputs);
    expect(maxError(gain4.outputs.main[0], Float32Array.from(original.outputs.main[0], x => x * 4))).toBeLessThan(1e-7);
  });
  test(`reset processes current input, held reset, noninitial snapshots and isolated state at ${rate}`, async () => {
    const config = { sampleRate: rate, bands }, n = 4096, inputs = signal(rate, n);
    inputs[4].fill(0); inputs[4][257] = 1; inputs[4].fill(1, 383, 387); inputs[4][2049] = 1;
    const whole = await render(config, inputs, undefined, true), expected = reference(config, inputs);
    for (let ch = 0; ch <= bands.length; ch++) expect(maxError(whole.outputs.main[ch], expected[ch])).toBeLessThan(3e-6);
    expect(rms(whole.outputs.main[bands.length + 1])).toBe(0);
    expect(whole.outputs.main[0][257]).not.toBe(0);
    for (const split of [128, 256, 384, 2048]) {
      const first = await render(config, inputs.map(x => x.slice(0, split)), undefined, true);
      const continued = await render(config, inputs.map(x => x.slice(split)), first.state, true);
      whole.outputs.main.forEach((channel, ch) => expect(continued.outputs.main[ch]).toEqual(channel.slice(split)));
      expect(continued.state).toEqual(whole.state);
    }
    expect(Object.keys(inspect(whole.state).slots)).toHaveLength(bands.length * 6 * 2);
    const held = [fill(256, .5), fill(256, .25), fill(256), fill(256), fill(256, 1)];
    const reset = await render(config, held);
    expect(reset.outputs.main[0][0]).toBeGreaterThan(0);
    expect(new Set(reset.outputs.main[0]).size).toBe(1);
    const clear = inputs.map(x => x.slice()); clear[0].fill(0, 1024); clear[1].fill(0, 1024); clear[4][1024] = 1;
    const cleared = await render(config, clear);
    expect(cleared.outputs.main.every(channel => channel.slice(1024).every(x => x === 0))).toBe(true);
  });
}

test('construction rejects malformed domain, counts, records, sparse, duplicate and unordered bands', () => {
  const one = { frequencyHz: 1000, q: 4, gain: 1 };
  for (const sampleRate of [0, 7999, 192001, 48000.5, NaN, Infinity]) expect(() => processor({ sampleRate, bands: [one] })).toThrow();
  const invalid = [[], new Array(2), [one, , { ...one, frequencyHz: 2000 }], [one, one], [{ ...one, frequencyHz: 2000 }, one], [null], [undefined], ['x'],
    Array.from({ length: 9 }, (_, i) => ({ ...one, frequencyHz: 1000 + i }))];
  for (const key of ['frequencyHz', 'q', 'gain']) for (const value of [NaN, Infinity, -Infinity]) invalid.push([{ ...one, [key]: value }]);
  for (const band of [{ ...one, frequencyHz: 19 }, { ...one, frequencyHz: 20001 }, { ...one, q: .49 }, { ...one, q: 10.01 }, { ...one, gain: -1 }, { ...one, gain: 4.01 }]) invalid.push([band]);
  for (const bad of invalid) expect(() => processor({ sampleRate: 48000, bands: bad as FilterBankVocoderBand[] })).toThrow();
});

test('eight bands, endpoint rates/frequencies/Q/gains and malformed controls retain finite state', async () => {
  for (const rate of [8000, 192000]) {
    const maximum = Math.min(20000, .45 * rate), config = { sampleRate: rate, bands: Array.from({ length: 8 }, (_, i) => ({ frequencyHz: 20 * (maximum / 20) ** (i / 7), q: i % 2 ? 10 : .5, gain: i % 2 ? 4 : 0 })) };
    const inputs = signal(rate, 512);
    for (let n = 0; n < 512; n++) { inputs[0][n] = n % 13 ? inputs[0][n] : NaN; inputs[1][n] = n % 17 ? inputs[1][n] : Infinity; inputs[2][n] = [NaN, -1, 0, .2 / rate, 1e6][n % 5]; inputs[3][n] = [-Infinity, .001, 30, 100][n % 4]; }
    const actual = await render(config, inputs), expected = reference(config, inputs);
    actual.outputs.main.forEach((channel, ch) => expect(maxError(channel, expected[ch])).toBeLessThan(1e-5));
  }
});
