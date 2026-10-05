import { expect, test } from 'vitest';
import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, type Node } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { additiveSource, frequencyModulation, phaseModulation, unisonSource, type FrequencyModulationControls, type PhaseModulationControls } from '../src/source.js';
import { bessel, clamp, f, operatorReference, sineBin } from './fixtures/source-reference.js';

const rates = [44100, 48000, 96000];
const duration = (frames: number, rate: number) => (frames - 0.25) / rate;
function close(actual: Float32Array, expected: Float32Array | number[], tolerance = 3e-6) {
  expect(actual.length).toBe(expected.length);
  let error = 0; actual.forEach((value, n) => { expect(Number.isFinite(value)).toBe(true); error = Math.max(error, Math.abs(value - expected[n])); });
  expect(error).toBeLessThan(tolerance);
}
function operatorProcessor(rate: number, fm: boolean) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 5, name: 'controls' }), output = audioOutput({ channels: 1, name: 'main' });
    const operator = fm ? instantiate(frequencyModulation, { sampleRate: rate }, { name: 'operator' }) : instantiate(phaseModulation, { sampleRate: rate }, { name: 'operator' });
    return { process() { forSample(i => {
      const c = { carrierHz: input.ch(0).at(i), modulatorHz: input.ch(1).at(i), reset: input.ch(4).at(i).gt(0) };
      output.ch(0).at(i).write(fm ? (operator as { tick(c: FrequencyModulationControls): Node<'f32'> }).tick({ ...c, deviationHz: input.ch(2).at(i), feedbackHz: input.ch(3).at(i) }) :
        (operator as { tick(c: PhaseModulationControls): Node<'f32'> }).tick({ ...c, depthRadians: input.ch(2).at(i), feedbackRadians: input.ch(3).at(i) }));
    }); } };
  });
}

for (const rate of rates) {
  test(`PM/FM extreme finite feedback stays bounded and clamps deterministically ${rate}`, async () => {
    const frames = 512;
    for (const fm of [false, true]) {
      const extreme = [new Float32Array(frames).fill(1e6), new Float32Array(frames).fill(1e6),
        Float32Array.from({ length: frames }, (_, n) => n % 64 < 32 ? -1e6 : 1e6),
        Float32Array.from({ length: frames }, (_, n) => n % 128 < 64 ? -1e6 : 1e6),
        Float32Array.from({ length: frames }, (_, n) => n % 31 === 0 ? 1 : 0)];
      const limits = [0.45 * rate, 0.45 * rate, fm ? 0.45 * rate : 8 * Math.PI, fm ? 0.45 * rate : Math.PI];
      const clamped = extreme.map((channel, index) => index < 4 ? Float32Array.from(channel, x => clamp(x, -limits[index], limits[index])) : channel);
      const processor = operatorProcessor(rate, fm);
      const result = await renderOffline(processor, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls: extreme } });
      const bounded = await renderOffline(processor, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls: clamped } });
      expect(result.outputs.main[0]).toEqual(bounded.outputs.main[0]);
      expect(Math.max(...result.outputs.main[0].map(Math.abs))).toBeLessThanOrEqual(1);
      expect(result.diagnostics.scrubbedSamples).toBe(0);
    }
  });

  for (const fm of [false, true]) test(`${fm ? 'FM Hz' : 'PM radians'} independent time-domain oracle, boundaries/reset/hold/snapshot ${rate}`, async () => {
    const frames = 1024;
    const controls = [Float32Array.from({ length: frames }, (_, n) => n < 128 ? -10 : n < 768 ? 440 + n : rate),
      Float32Array.from({ length: frames }, (_, n) => n < 128 ? 0 : n < 768 ? 123 : rate),
      Float32Array.from({ length: frames }, (_, n) => fm ? 1100 * Math.sin(n / 150) : 1.2 * Math.sin(n / 150)),
      new Float32Array(frames).fill(fm ? 50 : 0.15),
      Float32Array.from({ length: frames }, (_, n) => n === 129 || n >= 500 && n < 520 ? 1 : 0)];
    const processor = operatorProcessor(rate, fm);
    const full = await renderOffline(processor, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls } });
    close(full.outputs.main[0], operatorReference(rate, controls, fm));
    expect(full.diagnostics.scrubbedSamples).toBe(0);
    expect(Array.from(full.outputs.main[0].slice(500, 520))).toEqual(Array(20).fill(0));
    const first = await renderOffline(processor, { sampleRate: rate, duration: duration(512, rate), inputs: { controls: controls.map(x => x.slice(0, 512)) } });
    const rest = await renderOffline(processor, { sampleRate: rate, duration: duration(512, rate), inputs: { controls: controls.map(x => x.slice(512)) }, restore: first.state });
    expect(rest.outputs.main[0]).toEqual(full.outputs.main[0].slice(512));
  });

  test(`PM Bessel sidebands and explicit folded alias counterexample ${rate}`, async () => {
    const frames = 4096, processor = operatorProcessor(rate, false);
    const controls = (carrier: number, modulator: number, depth: number) => [new Float32Array(frames).fill(carrier), new Float32Array(frames).fill(modulator),
      new Float32Array(frames).fill(depth), new Float32Array(frames), new Float32Array(frames)];
    const result = await renderOffline(processor, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls: controls(rate * 512 / frames, rate * 32 / frames, 2) } });
    for (let order = -5; order <= 5; order++) expect(sineBin(result.outputs.main[0], 512 + order * 32).sine).toBeCloseTo(bessel(order, 2), 5);
    const alias = await renderOffline(processor, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls: controls(rate * 5 / 16, rate / 4, 1) } });
    // Sidebands are ABOVE Nyquist despite legal carrier/modulator rates. Sum all
    // analytical orders landing at the folded 7/16-rate frequency, with sign.
    let expected = 0;
    for (let order = -24; order <= 24; order++) {
      const raw = 5 / 16 + order / 4, folded = raw - Math.floor(raw + 0.5);
      if (Math.abs(Math.abs(folded) - 7 / 16) < 1e-12) expected += Math.sign(folded) * bessel(order, 1);
    }
    expect(sineBin(alias.outputs.main[0], frames * 7 / 16).sine).toBeCloseTo(expected, 5);
    expect(sineBin(alias.outputs.main[0], frames * 7 / 16).magnitude).toBeGreaterThan(0.4);
    expect(alias.diagnostics.scrubbedSamples).toBe(0);
  });

  test(`additive partial peaks, normalized sum, independent instances and maximum capacity ${rate}`, async () => {
    const frames = 4096, frequency = rate * 16 / frames;
    const partials = Array.from({ length: 32 }, (_, n) => ({ ratio: n + 1, gain: n % 2 ? -1 / (n + 1) : 1 / (n + 1) }));
    const denominator = partials.reduce((sum, p) => sum + Math.abs(p.gain), 0);
    const processor = defineProcessor(() => {
      const output = audioOutput({ channels: 2, name: 'main' });
      const a = instantiate(additiveSource, { sampleRate: rate, partials }, { name: 'additive' });
      const b = instantiate(additiveSource, { sampleRate: rate, partials: [{ ratio: 1, gain: 0 }] }, { name: 'silent' });
      return { process() { forSample(i => { output.ch(0).at(i).write(a.tick(f32(frequency), bool(false))); output.ch(1).at(i).write(b.tick(f32(frequency), bool(false))); }); } };
    });
    const result = await renderOffline(processor, { sampleRate: rate, duration: duration(frames, rate) });
    close(result.outputs.main[0], Float32Array.from({ length: frames }, (_, n) => partials.reduce((sum, p) => sum + p.gain / denominator * Math.sin(2 * Math.PI * f(frequency * p.ratio) * n / rate), 0)));
    for (const p of partials) expect(sineBin(result.outputs.main[0], 16 * p.ratio).sine).toBeCloseTo(p.gain / denominator, 5);
    expect(result.outputs.main[1]).toEqual(new Float32Array(frames));
    expect(result.diagnostics.scrubbedSamples).toBe(0);
    const first = await renderOffline(processor, { sampleRate: rate, duration: duration(256, rate) });
    const rest = await renderOffline(processor, { sampleRate: rate, duration: duration(128, rate), restore: first.state });
    expect(rest.outputs.main[0]).toEqual(result.outputs.main[0].slice(256, 384));
  });

  test(`additive abrupt partial cutoff and reset at crossing ${rate}`, async () => {
    const frames = 256, frequencies = Float32Array.from({ length: frames }, (_, n) => n < 128 ? 0.224 * rate : 0.226 * rate);
    const processor = defineProcessor(() => {
      const input = audioInput({ channels: 2, name: 'controls' }), output = audioOutput({ channels: 1, name: 'main' });
      const source = instantiate(additiveSource, { sampleRate: rate, partials: [{ ratio: 2, gain: 1 }] }, { name: 'source' });
      return { process() { forSample(i => output.ch(0).at(i).write(source.tick(input.ch(0).at(i), input.ch(1).at(i).gt(0)))); } };
    });
    const reset = Float32Array.from({ length: frames }, (_, n) => n >= 64 && n <= 67 ? 1 : 0);
    const result = await renderOffline(processor, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls: [frequencies, reset] } });
    close(result.outputs.main[0].slice(0, 128), Float32Array.from({ length: 128 }, (_, n) => Math.sin(2 * Math.PI * f(frequencies[0] * 2) * (n < 64 ? n : n <= 67 ? 0 : n - 67) / rate)));
    expect(result.outputs.main[0].slice(128)).toEqual(new Float32Array(128));
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  });

  test(`unison maximum bank, detune near ceiling, linear pan and mono fold-down ${rate}`, async () => {
    const frames = 512, voices = Array.from({ length: 8 }, (_, n) => ({ detuneCents: -1200 + n * 2400 / 7, pan: -1 + n * 2 / 7 }));
    const frequency = f(0.4 * rate);
    const processor = defineProcessor(() => {
      const input = audioInput({ channels: 1, name: 'controls' }), output = audioOutput({ channels: 2, name: 'main' });
      const source = instantiate(unisonSource, { sampleRate: rate, waveform: 'sine', voices }, { name: 'source' });
      return { process() { forSample(i => { const sample = source.tick(f32(frequency), input.ch(0).at(i).gt(0)); output.ch(0).at(i).write(sample.left); output.ch(1).at(i).write(sample.right); }); } };
    });
    const reset = Float32Array.from({ length: frames }, (_, n) => n >= 255 && n <= 260 ? 1 : 0);
    const result = await renderOffline(processor, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls: [reset] } });
    const effective = voices.map(v => Math.min(f(clamp(frequency * 2 ** (v.detuneCents / 1200), 0, 0.45 * rate)), 0.45 * rate));
    for (const [ch, sign] of [[0, -1], [1, 1]]) close(result.outputs.main[ch], Float32Array.from({ length: frames }, (_, n) => voices.reduce((sum, v, index) =>
      sum + (1 + sign * v.pan) / 16 * Math.sin(2 * Math.PI * effective[index] * (n < 255 ? n : n <= 260 ? 0 : n - 260) / rate), 0)));
    close(Float32Array.from(result.outputs.main[0], (left, n) => left + result.outputs.main[1][n]), Float32Array.from({ length: frames }, (_, n) => effective.reduce((sum, hz) => sum + Math.sin(2 * Math.PI * hz * (n < 255 ? n : n <= 260 ? 0 : n - 260) / rate) / 8, 0)));
    expect(result.diagnostics.scrubbedSamples).toBe(0);
    const first = await renderOffline(processor, { sampleRate: rate, duration: duration(384, rate), inputs: { controls: [reset.slice(0, 384)] } });
    const rest = await renderOffline(processor, { sampleRate: rate, duration: duration(128, rate), inputs: { controls: [reset.slice(384)] }, restore: first.state });
    expect(rest.outputs.main).toEqual(result.outputs.main.map(ch => ch.slice(384)));
  });
}

test('construction rejects invalid rates, counts, partials and unison controls', async () => {
  const check = async (make: () => unknown) => {
    expect(() => defineProcessor(() => { make(); return { process() {} }; })).toThrow(RangeError);
  };
  for (const sampleRate of [NaN, Infinity, 7999, 192001]) await check(() => instantiate(phaseModulation, { sampleRate }, { name: 'invalid' }));
  for (const count of [0, 33]) await check(() => instantiate(additiveSource, { sampleRate: 48000, partials: Array.from({ length: count }, () => ({ ratio: 1, gain: 1 })) }, { name: 'invalid' }));
  for (const ratio of [0, 129, NaN]) await check(() => instantiate(additiveSource, { sampleRate: 48000, partials: [{ ratio, gain: 1 }] }, { name: 'invalid' }));
  await check(() => instantiate(additiveSource, { sampleRate: 48000, partials: [{ ratio: 1, gain: Infinity }] }, { name: 'invalid' }));
  for (const voices of [[], Array.from({ length: 9 }, () => ({ detuneCents: 0, pan: 0 })), [{ detuneCents: 1201, pan: 0 }], [{ detuneCents: 0, pan: 1.1 }]]) await check(() => instantiate(unisonSource, { sampleRate: 48000, waveform: 'sine', voices }, { name: 'invalid' }));
});
