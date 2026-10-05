import { expect, test } from 'vitest';
import { audioInput, audioOutput, CAPACITY_16, defineProcessor, event, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { residentSample } from '../src/sample.js';
import { bandedWavetableSource, wavetableSource } from '../src/wavetable.js';
import { wavetableSource as beforeSource } from './fixtures/wavetable-before-local-fraction.js';
import { bandedWavetableSource as beforeBands } from './fixtures/wavetable-bands-before-local-fraction.js';
const rate = 48000, n = 128;
function make(variant: string, phase: number, length = 16, count = 2, capacity = 96) {
  return defineProcessor(() => {
    const sample = instantiate(residentSample, { capacity, sourceSampleRate: rate }, { name: 'asset' });
    const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: capacity * 4 });
    load.onReceive(({ data }) => sample.load(data));
    const source = instantiate(variant === 'before' ? beforeSource : variant === 'beforeBands' ? beforeBands : variant === 'bands' ? bandedWavetableSource : wavetableSource,
      { sampleRate: rate, sample, frameLength: length, frameCount: count, phaseCycles: phase }, { name: 'source' });
    const input = audioInput({ channels: 3, name: 'controls' }), output = audioOutput({ channels: 1, name: 'main' });
    return { process() { forSample(i => { output.ch(0).at(i).write(source.tick({ frequencyHz: input.ch(0).at(i), frame: input.ch(1).at(i), reset: input.ch(2).at(i).gt(0) }).output); }); } };
  });
}
const controls = (frequency: number, frame: number, reset = false) => [new Float32Array(n).fill(frequency), new Float32Array(n).fill(frame), new Float32Array(n).fill(+reset)];
async function run(variant: string, phase: number, data: Float32Array, input: Float32Array[], length = 16, count = 2) {
  const r = await renderOffline(make(variant, phase, length, count, data.length), { sampleRate: rate, duration: (n - .25) / rate, inputs: { controls: input }, messages: [{ name: 'load', payload: { data } }] });
  expect(r.diagnostics.scrubbedSamples).toBe(0); return r.outputs.main[0];
}
test('frozen before/after: tiny local phase survives both readers at nonzero frame/band offsets', async () => {
  const data = new Float32Array(96); for (let i = 0; i < 6; i++) data[i * 16 + 1] = 3e38;
  const expected = Math.fround(data[1] * 16e-40);
  for (const [before, after] of [['before', 'source'], ['beforeBands', 'bands']]) {
    const input = controls(0, 1, true);
    expect(await run(before, 1e-40, data, input)).toEqual(new Float32Array(n));
    expect(await run(after, 1e-40, data, input)).toEqual(new Float32Array(n).fill(expected));
  }
  expect(await run('beforeBands', 1e-40, data, controls(10000, 0, true))).toEqual(new Float32Array(n));
  expect(await run('bands', 1e-40, data, controls(10000, 0, true))).toEqual(new Float32Array(n).fill(expected));
});
test('ordinary coherent fractional PCM is bit-identical; ordinary nonbinary increments remain close', async () => {
  const data = Float32Array.from({ length: 640 }, (_, i) => .6 * Math.sin(2 * Math.PI * (i % 64) / 64) + .2 * Math.cos(6 * Math.PI * (i % 64) / 64));
  for (const [before, after] of [['before', 'source'], ['beforeBands', 'bands']]) {
    const coherent = controls(rate / 256, .375), a = await run(before, .125, data, coherent, 64), b = await run(after, .125, data, coherent, 64);
    expect(b).toEqual(a);
    const input = controls(1379.25, .375), old = await run(before, .975, data, input, 64), current = await run(after, .975, data, input, 64);
    current.forEach((x, i) => expect(Math.abs(x - old[i])).toBeLessThan(2e-6));
  }
});
test('near-last-sample wraps locally at high frame offsets with extreme finite PCM', async () => {
  const size = 16, count = 16, data = new Float32Array(size * count * 3), phase = 1 - 2 ** -53;
  for (let cycle = 0; cycle < count * 3; cycle++) { data[cycle * size] = 1; data[cycle * size + size - 1] = 3e38; }
  const fraction = phase * size - Math.floor(phase * size), expected = Math.fround(data[15] * (1 - fraction) + fraction);
  for (const variant of ['source', 'bands']) {
    const actual = await run(variant, phase, data, controls(10000, 15, true), size, count);
    expect(actual).toEqual(new Float32Array(n).fill(expected)); expect(Number.isFinite(actual[0])).toBe(true);
  }
});
