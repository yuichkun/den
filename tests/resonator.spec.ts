import { expect, test } from 'vitest';
import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { modalResonator, tunedComb, type ResonatorMode } from '../src/resonator.js';
import { f, modalImpulse, normalizedCombReference } from './fixtures/source-reference.js';
import { combWithOutputNormalizationBefore } from './fixtures/comb-output-normalization-before.js';

const rates = [44100, 48000, 96000], duration = (frames: number, rate: number) => (frames - 0.25) / rate;
function close(actual: Float32Array, expected: Float32Array | number[], tolerance = 3e-6) {
  expect(actual.length).toBe(expected.length);
  let error = 0; actual.forEach((value, n) => { expect(Number.isFinite(value)).toBe(true); error = Math.max(error, Math.abs(value - expected[n])); });
  expect(error).toBeLessThan(tolerance);
}
function modalProcessor(rate: number, modes: ResonatorMode[]) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 2, name: 'controls' }), output = audioOutput({ channels: 2, name: 'main' });
    const source = instantiate(modalResonator, { sampleRate: rate, modes }, { name: 'modal' });
    const silent = instantiate(modalResonator, { sampleRate: rate, modes: [{ frequencyHz: 1000, decaySeconds: 0.2, gain: 1 }] }, { name: 'silent' });
    return { process() { forSample(i => {
      output.ch(0).at(i).write(source.tick(input.ch(0).at(i), input.ch(1).at(i).gt(0)));
      output.ch(1).at(i).write(silent.tick(f32(0), bool(false)));
    }); } };
  });
}
function combProcessor(rate: number, minimum = 20, legacy = false) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 5, name: 'controls' }), output = audioOutput({ channels: 1, name: 'main' });
    const source = instantiate(legacy ? combWithOutputNormalizationBefore : tunedComb, { sampleRate: rate, minFrequencyHz: minimum }, { name: 'comb' });
    return { process() { forSample(i => output.ch(0).at(i).write(source.tick({ input: input.ch(0).at(i), frequencyHz: input.ch(1).at(i),
      feedback: input.ch(2).at(i), damping: input.ch(3).at(i), reset: input.ch(4).at(i).gt(0) }))); } };
  });
}

for (const rate of rates) {
  test(`comb adversarial automation follows normalized-history oracle without releasing stored gain ${rate}`, async () => {
    const frames = 32768;
    let seed = 1729;
    const input = Float32Array.from({ length: frames }, (_, n) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return n < 8192 ? 1 : n % 31 === 0 ? 1 : 2 * seed / 0x100000000 - 1;
    });
    const controls = [input,
      Float32Array.from({ length: frames }, (_, n) => n < 8192 ? rate : [20, rate, -1, 73.4, rate / 17.25][n % 5]),
      Float32Array.from({ length: frames }, (_, n) => n < 8192 ? 2 : n < 8200 ? 0 : [-2, 2, 0, 0.7, -0.3][n % 5]),
      Float32Array.from({ length: frames }, (_, n) => n < 8192 ? 0 : [-1, 0.8, 2, 0.999, 0.25][n % 5]),
      Float32Array.from({ length: frames }, (_, n) => n === 18001 || n >= 30000 && n < 30016 ? 1 : 0)];
    const result = await renderOffline(combProcessor(rate), { sampleRate: rate, duration: duration(frames, rate), inputs: { controls } });
    close(result.outputs.main[0], normalizedCombReference(rate, controls), 5e-6);
    expect(Math.max(...result.outputs.main[0].map(Math.abs))).toBeLessThanOrEqual(1.001);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
    const first = await renderOffline(combProcessor(rate), { sampleRate: rate, duration: duration(16384, rate), inputs: { controls: controls.map(c => c.slice(0, 16384)) } });
    const rest = await renderOffline(combProcessor(rate), { sampleRate: rate, duration: duration(16384, rate), inputs: { controls: controls.map(c => c.slice(16384)) }, restore: first.state });
    expect(rest.outputs.main[0]).toEqual(result.outputs.main[0].slice(16384));
    const amplifiedControls = controls.map((c, index) => index === 0 ? Float32Array.from(c, x => x * 2) : c);
    const amplified = await renderOffline(combProcessor(rate), { sampleRate: rate, duration: duration(frames, rate), inputs: { controls: amplifiedControls } });
    expect(amplified.outputs.main[0]).toEqual(Float32Array.from(result.outputs.main[0], x => x * 2));
  });

  test(`comb fractional-delay repeats follow the analytical binomial impulse series ${rate}`, async () => {
    const frames = 2048, requestedFrequency = f(rate / 17.25), delay = f(1 / requestedFrequency) * rate;
    const whole = Math.floor(delay), fraction = delay - whole, feedback = 0.5;
    const input = new Float32Array(frames); input[0] = 1;
    const controls = [input, new Float32Array(frames).fill(requestedFrequency), new Float32Array(frames).fill(feedback), new Float32Array(frames), new Float32Array(frames)];
    const result = await renderOffline(combProcessor(rate), { sampleRate: rate, duration: duration(frames, rate), inputs: { controls } });
    const expected = new Float32Array(frames);
    for (let repetition = 1; repetition * whole < frames; repetition++) {
      let choose = 1;
      for (let extra = 0; extra <= repetition; extra++) {
        const index = repetition * whole + extra;
        if (index < frames) expected[index] += (1 - feedback) * feedback ** (repetition - 1) * choose * (1 - fraction) ** (repetition - extra) * fraction ** extra;
        choose *= (repetition - extra) / (extra + 1);
      }
    }
    close(result.outputs.main[0], expected, 3e-6); expect(result.diagnostics.scrubbedSamples).toBe(0);
  });

  test(`modal analytical poles/tuning/T60 impulse, reset and tiny tails ${rate}`, async () => {
    const frames = 8192, modes = [{ frequencyHz: 731, decaySeconds: 0.08, gain: 1 }, { frequencyHz: 1733, decaySeconds: 0.13, gain: -0.4 }];
    const source = modalProcessor(rate, modes), input = new Float32Array(frames); input[0] = 1;
    const result = await renderOffline(source, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls: [input, new Float32Array(frames)] } });
    close(result.outputs.main[0], modalImpulse(rate, frames, modes));
    expect(result.outputs.main[1]).toEqual(new Float32Array(frames)); expect(result.diagnostics.scrubbedSamples).toBe(0);
    // Independent reset emits the current input's zero-history response, even
    // with a restored ringing state. Held reset reapplies that response only.
    const excitation = new Float32Array(256).fill(0.25), reset = new Float32Array(256); reset.fill(1, 0, 128);
    const resumed = await renderOffline(source, { sampleRate: rate, duration: duration(256, rate), inputs: { controls: [excitation, reset] }, restore: result.state });
    const first = modalImpulse(rate, 1, modes)[0] / 4;
    close(resumed.outputs.main[0].slice(0, 128), new Float32Array(128).fill(first));
    const tiny = new Float32Array(512); tiny[0] = 1e-35;
    const tinyResult = await renderOffline(source, { sampleRate: rate, duration: duration(512, rate), inputs: { controls: [tiny, new Float32Array(512)] } });
    close(tinyResult.outputs.main[0], Float32Array.from(modalImpulse(rate, 512, modes), x => x * tiny[0]), 1e-40);
    expect(Math.abs(tinyResult.outputs.main[0][100])).toBeGreaterThan(1e-38);
  });

  test(`modal max 16 modes, sustained resonance/headroom, bounded strong excitation and exact snapshot ${rate}`, async () => {
    const frames = 32768, modes = Array.from({ length: 16 }, (_, n) => ({ frequencyHz: n === 0 ? 20 : 100 + n * 53, decaySeconds: 30, gain: 1 }));
    const source = modalProcessor(rate, modes), input = Float32Array.from({ length: frames }, (_, n) => 2 * Math.sin(2 * Math.PI * 20 * n / rate));
    const reset = new Float32Array(frames), full = await renderOffline(source, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls: [input, reset] } });
    const peak = Math.max(...full.outputs.main[0].map(Math.abs));
    expect(peak).toBeGreaterThan(10); // Σ|gain| normalization is not a driven peak limiter.
    const bound = 1 / (1 - Math.exp(-Math.log(1000) / (30 * rate)));
    expect(peak).toBeLessThan(bound); expect(full.diagnostics.scrubbedSamples).toBe(0);
    const half = await renderOffline(source, { sampleRate: rate, duration: duration(16384, rate), inputs: { controls: [input.slice(0, 16384), reset.slice(0, 16384)] } });
    const rest = await renderOffline(source, { sampleRate: rate, duration: duration(16384, rate), inputs: { controls: [input.slice(16384), reset.slice(16384)] }, restore: half.state });
    expect(rest.outputs.main).toEqual(full.outputs.main.map(ch => ch.slice(16384)));
    const tail = await renderOffline(source, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls: [reset, reset] }, restore: full.state });
    expect(Math.max(...tail.outputs.main[0].map(Math.abs))).toBeLessThan(bound); expect(tail.diagnostics.scrubbedSamples).toBe(0);
  });

  test(`comb integer tuning, signed decay and damping freeze ${rate}`, async () => {
    const frames = 4096, delay = 64, frequency = rate / delay;
    for (const feedback of [0.75, -0.75]) {
      const input = new Float32Array(frames); input[0] = 1;
      const controls = [input, new Float32Array(frames).fill(frequency), new Float32Array(frames).fill(feedback), new Float32Array(frames), new Float32Array(frames)];
      const source = combProcessor(rate), result = await renderOffline(source, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls } });
      // Actual delay conversion passes through f32 seconds. Quantify the tiny
      // interpolation loss rather than pretending an exact integer tap exists.
      const expected = Float32Array.from({ length: frames }, (_, n) => n >= delay && n % delay === 0 ? 0.25 * feedback ** (n / delay - 1) : 0);
      close(result.outputs.main[0], expected, 3e-5); expect(result.diagnostics.scrubbedSamples).toBe(0);
      controls[3].fill(1);
      const frozen = await renderOffline(source, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls } });
      close(frozen.outputs.main[0], Float32Array.from({ length: frames }, (_, n) => n === delay ? 0.25 : 0), 3e-6);
    }
  });

  test(`comb minimum/maximum delay, modulation/reset bounds and snapshot ${rate}`, async () => {
    const frames = 8192, source = combProcessor(rate);
    const controls = [Float32Array.from({ length: frames }, (_, n) => n < 4096 ? (n % 3 ? 50 : -50) : 0),
      Float32Array.from({ length: frames }, (_, n) => n % 3 === 0 ? -10 : n % 3 === 1 ? rate : 73.4),
      Float32Array.from({ length: frames }, (_, n) => n < 4096 ? 2 : -2),
      Float32Array.from({ length: frames }, (_, n) => n % 64 / 63),
      Float32Array.from({ length: frames }, (_, n) => n >= 6000 && n < 6100 ? 1 : 0)];
    const full = await renderOffline(source, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls } });
    full.outputs.main[0].forEach(x => expect(Number.isFinite(x)).toBe(true));
    // Input magnitude ≤50; convex interpolation/damping and normalized excitation
    // bound history by 50 in ideal arithmetic, without clipping the input.
    expect(Math.max(...full.outputs.main[0].map(Math.abs))).toBeLessThanOrEqual(50.05);
    expect(full.outputs.main[0].slice(6000, 6100)).toEqual(new Float32Array(100));
    expect(full.diagnostics.scrubbedSamples).toBe(0);
    const first = await renderOffline(source, { sampleRate: rate, duration: duration(4096, rate), inputs: { controls: controls.map(x => x.slice(0, 4096)) } });
    const rest = await renderOffline(source, { sampleRate: rate, duration: duration(4096, rate), inputs: { controls: controls.map(x => x.slice(4096)) }, restore: first.state });
    expect(rest.outputs.main[0]).toEqual(full.outputs.main[0].slice(4096));
    // Fixed-feedback DC approaches unity. Changing feedback does not rescale
    // the stored history, so there is no release of artificially amplified energy.
    const dc = [new Float32Array(frames).fill(1), new Float32Array(frames).fill(0.45 * rate),
      Float32Array.from({ length: frames }, (_, n) => n < 6000 ? 0.999 : 0), new Float32Array(frames), new Float32Array(frames)];
    const changed = await renderOffline(source, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls: dc } });
    expect(Math.max(...changed.outputs.main[0].slice(0, 6000).map(Math.abs))).toBeLessThanOrEqual(1.001);
    expect(changed.outputs.main[0][6000]).toBeGreaterThan(0.8);
    expect(Math.max(...changed.outputs.main[0].map(Math.abs))).toBeLessThanOrEqual(1.001);
    expect(changed.diagnostics.scrubbedSamples).toBe(0);
    const rejected = await renderOffline(combProcessor(rate, 20, true), { sampleRate: rate, duration: duration(frames, rate), inputs: { controls: dc } });
    // The former topology agrees at fixed g but creates a >100x burst on a
    // feedback edit. Keep the actual old DSP executable so this regression
    // cannot be erased by updating a generated expected-audio file.
    close(changed.outputs.main[0].slice(0, 6000), rejected.outputs.main[0].slice(0, 6000), 0.0002);
    expect(rejected.outputs.main[0][6000]).toBeGreaterThan(100);
  });
}

test('modal and comb construction reject nonfinite/invalid capacities and coefficients', async () => {
  const check = async (make: () => unknown) => {
    expect(() => defineProcessor(() => { make(); return { process() {} }; })).toThrow(RangeError);
  };
  for (const sampleRate of [NaN, Infinity, 7999, 192001]) await check(() => instantiate(modalResonator, { sampleRate, modes: [] }, { name: 'invalid' }));
  for (const count of [0, 17]) await check(() => instantiate(modalResonator, { sampleRate: 48000, modes: Array.from({ length: count }, () => ({ frequencyHz: 100, decaySeconds: 1, gain: 1 })) }, { name: 'invalid' }));
  for (const mode of [{ frequencyHz: 0, decaySeconds: 1, gain: 1 }, { frequencyHz: 22000, decaySeconds: 1, gain: 1 }, { frequencyHz: 100, decaySeconds: 31, gain: 1 }, { frequencyHz: 100, decaySeconds: 1, gain: NaN }])
    await check(() => instantiate(modalResonator, { sampleRate: 48000, modes: [mode] }, { name: 'invalid' }));
  for (const minFrequencyHz of [0, 19, 24000, Infinity, NaN]) await check(() => instantiate(tunedComb, { sampleRate: 48000, minFrequencyHz }, { name: 'invalid' }));
});
