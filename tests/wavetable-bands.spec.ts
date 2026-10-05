import { expect, test } from 'vitest';
import { audioInput, audioOutput, CAPACITY_16, compile, decodeSnapshot, defineProcessor, encodeScalar, encodeSnapshot, event, f32, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { residentSample } from '../src/sample.js';
import { bandedWavetableSource, prepareWavetableBands } from '../src/wavetable.js';
import { bandLimits, bandsReference, coefficient, project } from './fixtures/wavetable-bands-reference.js';
const rates = [44100, 48000, 96000], duration = (n: number, rate: number) => (n - .25) / rate;
function close(actual: Float32Array, expected: Float32Array, tolerance = 2e-6) {
  expect(actual.length).toBe(expected.length); let error = 0;
  actual.forEach((x, n) => { expect(Number.isFinite(x)).toBe(true); error = Math.max(error, Math.abs(x - expected[n])); });
  expect(error).toBeLessThan(tolerance);
}
function processor(rate: number, frameLength = 64, frameCount = 2, phaseCycles = .125, capacity = frameLength * frameCount * bandLimits(frameLength).length) {
  return defineProcessor(() => {
    const sample = instantiate(residentSample, { capacity, sourceSampleRate: 32000 }, { name: 'asset' });
    const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: capacity * 4 });
    load.onReceive(({ data }) => sample.load(data));
    const source = instantiate(bandedWavetableSource, { sampleRate: rate, sample, frameLength, frameCount, phaseCycles }, { name: 'source' });
    const input = audioInput({ channels: 3, name: 'controls' }), output = audioOutput({ channels: 2, name: 'main' });
    return { process() { forSample(i => {
      const result = source.tick({ frequencyHz: input.ch(0).at(i), frame: input.ch(1).at(i), reset: input.ch(2).at(i).gt(0) });
      output.ch(0).at(i).write(result.output); output.ch(1).at(i).write(f32(result.missing));
    }); } };
  });
}
const constant = (n: number, frequency: number, frame = 0) => [new Float32Array(n).fill(frequency), new Float32Array(n).fill(frame), new Float32Array(n)];
const original = (size: number, count = 2) => Array.from({ length: count }, (_, f) => Float32Array.from({ length: size }, (_, n) => .07 * f + .5 * Math.sin(2 * Math.PI * n / size + .3 * f) + .25 * Math.cos(6 * Math.PI * n / size) + .1 * Math.sin(22 * Math.PI * n / size)));
test('host FFT bands match independent real DFT, conjugate content, original DC/gain/phase and edits', () => {
  for (const size of [16, 32, 128]) {
    const frames = original(size), copies = frames.map(x => x.slice()), asset = prepareWavetableBands({ frames });
    close(asset.data, project(frames), 1e-7); expect(frames).toEqual(copies); expect(asset.harmonicLimits).toEqual(bandLimits(size));
    asset.harmonicLimits.forEach((limit, b) => frames.forEach((frame, f) => {
      const table = asset.data.slice((b * frames.length + f) * size, (b * frames.length + f + 1) * size);
      for (let k = 0; k <= size / 2; k++) {
        const observed = coefficient(table, k), expected = k <= limit ? coefficient(frame, k) : { re: 0, im: 0 };
        expect(observed.re).toBeCloseTo(expected.re, 7); expect(observed.im).toBeCloseTo(expected.im, 7);
      }
    }));
    frames[1][3] += .25; const changed = prepareWavetableBands({ frames });
    expect(changed.data).not.toEqual(asset.data); close(changed.data, project(frames), 1e-7);
  }
  const silent = prepareWavetableBands({ frames: [new Float32Array(64)] }); expect(silent.data).toEqual(new Float32Array(silent.data.length));
  const dc = prepareWavetableBands({ frames: [new Float32Array(16).fill(3.4028234663852886e38)] }); expect(dc.data).toEqual(new Float32Array(48).fill(3.4028234663852886e38));
});
for (const rate of rates) {
  test(`bands independent sweep, frame scan, all pitch boundaries, reset, hold and snapshot ${rate}`, async () => {
    const asset = prepareWavetableBands({ frames: original(64) }), n = 1024;
    const boundaries = asset.harmonicLimits.flatMap(h => [.225 * rate / h, .45 * rate / h]).flatMap(x => [x * (1 - 2e-7), x, x * (1 + 2e-7)]);
    const controls = [Float32Array.from({ length: n }, (_, i) => i < 256 ? boundaries[i % boundaries.length] : i < 512 ? rate * .45 * (i - 256) / 256 : [0, -1, NaN, Infinity, -Infinity, 1e-40][i % 6]),
      Float32Array.from({ length: n }, (_, i) => [0, .25, .5, 1, NaN, Infinity, -Infinity][i % 7]),
      Float32Array.from({ length: n }, (_, i) => +(i === 127 || i >= 700 && i < 710))];
    const p = processor(rate), full = await renderOffline(p, { sampleRate: rate, duration: duration(n, rate), inputs: { controls }, messages: [{ name: 'load', payload: { data: asset.data } }] });
    close(full.outputs.main[0], bandsReference(asset.data, rate, 64, 2, controls, .125)); expect(full.outputs.main[1]).toEqual(new Float32Array(n)); expect(full.diagnostics.scrubbedSamples).toBe(0);
    const first = await renderOffline(p, { sampleRate: rate, duration: duration(512, rate), inputs: { controls: controls.map(x => x.slice(0, 512)) }, messages: [{ name: 'load', payload: { data: asset.data } }] });
    const rest = await renderOffline(p, { sampleRate: rate, duration: duration(512, rate), inputs: { controls: controls.map(x => x.slice(512)) }, restore: first.state });
    expect(rest.outputs.main).toEqual(full.outputs.main.map(x => x.slice(512)));
  });
  test(`native replacement, short/empty silence, full edited asset and revision restart ${rate}`, async () => {
    const a = prepareWavetableBands({ frames: original(16) }), b = prepareWavetableBands({ frames: original(16).map(x => Float32Array.from(x, v => v * -.5)) });
    const p = processor(rate, 16, 2), controls = constant(768, rate / 53, .5);
    const r = await renderOffline(p, { sampleRate: rate, duration: duration(768, rate), inputs: { controls }, messages: [
      { name: 'load', payload: { data: a.data }, atQuantum: 1 }, { name: 'load', payload: { data: a.data.slice(0, -1) }, atQuantum: 2 },
      { name: 'load', payload: { data: b.data }, atQuantum: 3 }, { name: 'load', payload: { data: b.data }, atQuantum: 4 }, { name: 'load', payload: { data: new Float32Array() }, atQuantum: 5 },
    ] });
    for (const block of [0, 2, 5]) { expect(r.outputs.main[0].slice(block * 128, (block + 1) * 128)).toEqual(new Float32Array(128)); expect(r.outputs.main[1][block * 128]).toBe(1); }
    for (const block of [1, 3, 4]) close(r.outputs.main[0].slice(block * 128, (block + 1) * 128), bandsReference(block === 1 ? a.data : b.data, rate, 16, 2, controls.map(x => x.slice(0, 128)), .125));
    expect(r.outputs.main[0].slice(384, 512)).toEqual(r.outputs.main[0].slice(512, 640)); expect(r.diagnostics.scrubbedSamples).toBe(0);
  });
  test(`high-harmonic fold is rejected while linear interpolation image aliases remain ${rate}`, async () => {
    const n = 4096, high = prepareWavetableBands({ frames: [Float32Array.from({ length: 64 }, (_, i) => Math.sin(2 * Math.PI * 20 * i / 64))] });
    const r = await renderOffline(processor(rate, 64, 1, 0), { sampleRate: rate, duration: duration(n, rate), inputs: { controls: constant(n, rate / 32) }, messages: [{ name: 'load', payload: { data: high.data } }] });
    expect(coefficient(r.outputs.main[0], 1536).magnitude).toBeLessThan(1e-6);
    const sine = prepareWavetableBands({ frames: [Float32Array.from({ length: 16 }, (_, i) => Math.sin(2 * Math.PI * i / 16))] }), controls = constant(n, rate * 300 / n);
    const image = await renderOffline(processor(rate, 16, 1, 0), { sampleRate: rate, duration: duration(n, rate), inputs: { controls }, messages: [{ name: 'load', payload: { data: sine.data } }] });
    expect(coefficient(image.outputs.main[0], 300).magnitude).toBeGreaterThan(.98);
    expect(coefficient(image.outputs.main[0], 404).magnitude).toBeGreaterThan(.004);
    close(image.outputs.main[0], bandsReference(sine.data, rate, 16, 1, controls)); expect(image.diagnostics.scrubbedSamples).toBe(0);
  });
}
test('native full capacity, max size, invalid PCM, subnormals and revision wrap', async () => {
  for (const [size, count] of [[512, 16], [4096, 1]]) {
    const a = prepareWavetableBands({ frames: original(size, count) }), p = processor(48000, size, count, .975), controls = constant(256, 10001, count - 1);
    const full = await renderOffline(p, { sampleRate: 48000, duration: duration(256, 48000), inputs: { controls }, messages: [{ name: 'load', payload: { data: a.data } }] });
    close(full.outputs.main[0], bandsReference(a.data, 48000, size, count, controls, .975)); expect(full.diagnostics.scrubbedSamples).toBe(0);
    const compiled = await compile(p, { sampleRate: 48000 }), driver = await compiled.driver.instantiate(), bytes = driver.memory.buffer.byteLength;
    for (let i = 0; i < 32; i++) driver.process();
    expect(driver.memory.buffer.byteLength).toBe(bytes); expect(bytes).toBeLessThan(5 * 1024 * 1024); expect(compiled.wasm.byteLength).toBeLessThan(150 * 1024);
  }
  const data = Float32Array.from({ length: 96 }, (_, n) => [NaN, Infinity, -Infinity, 1e-40, -1e-40, 1e-38][n % 6]), p = processor(48000, 16, 2), controls = constant(256, 1357, .4);
  const first = await renderOffline(p, { sampleRate: 48000, duration: duration(256, 48000), inputs: { controls }, messages: [{ name: 'load', payload: { data } }] });
  close(first.outputs.main[0], bandsReference(data, 48000, 16, 2, controls, .125), 2e-44); expect(first.diagnostics.scrubbedSamples).toBe(0);
  for (const before of [2147483647, -1]) {
    const snapshot = decodeSnapshot(first.state), revisions = snapshot.slots.filter(s => s.name === 'asset/revision' || s.name === 'source/revision');
    expect(revisions.length).toBe(2); revisions.forEach(s => { s.data = encodeScalar('i32', before); });
    const restore = encodeSnapshot(snapshot.schemaHash, snapshot.profile, snapshot.slots, snapshot.processorId);
    const replacement = new Float32Array(96).fill(.25), r = await renderOffline(p, { sampleRate: 48000, duration: duration(256, 48000), inputs: { controls }, restore, messages: [{ name: 'load', payload: { data: replacement } }] });
    expect(r.outputs.main[0]).toEqual(new Float32Array(256).fill(.25));
  }
});
test('host and native reject invalid layouts, mismatches, nonfinite/overflow PCM', () => {
  for (const frames of [[], [new Float32Array(15)], [new Float32Array(17)], [new Float32Array(8192)], original(4096, 2), original(16, 17), [new Float32Array(16), new Float32Array(32)], [new Float32Array(16).fill(NaN)], [new Float32Array(16).fill(Infinity)], [Float32Array.from({ length: 16 }, (_, i) => (i < 8 ? 1 : -1) * 3.4028234663852886e38)]]) expect(() => prepareWavetableBands({ frames })).toThrow(RangeError);
  for (const [size, count, phase, capacity, rate] of [[15, 1, 0, 100, 48000], [16, 2, 0, 95, 48000], [4096, 2, 0, 65536, 48000], [16, 1, 1, 48, 48000], [16, 1, NaN, 48, 48000], [16, 1, 0, 48, 7999]]) expect(() => processor(rate, size, count, phase, capacity)).toThrow(RangeError);
});

test('tiny phase/frequency/morph and full finite native PCM; extra payload is ignored', async () => {
  const rate = 96000, n = 256, data = new Float32Array(128).fill(3e38);
  for (let b = 0; b < 3; b++) data[b * 32] = 0;
  const controls = constant(n, Math.fround(2 ** -149), Math.fround(1e-40));
  const p = processor(rate, 16, 2, 0, 128);
  const r = await renderOffline(p, { sampleRate: rate, duration: duration(n, rate), inputs: { controls }, messages: [{ name: 'load', payload: { data } }] });
  close(r.outputs.main[0], bandsReference(data, rate, 16, 2, controls), 1e-8); expect(r.outputs.main[0][255]).toBeGreaterThan(r.outputs.main[0][0]);
  expect(r.outputs.main[1]).toEqual(new Float32Array(n)); expect(r.diagnostics.scrubbedSamples).toBe(0);
  const tiny = processor(rate, 16, 1, Number.MIN_VALUE), input = constant(128, 0), asset = prepareWavetableBands({ frames: original(16, 1) });
  const first = await renderOffline(tiny, { sampleRate: rate, duration: duration(128, rate), inputs: { controls: input }, messages: [{ name: 'load', payload: { data: asset.data } }] });
  const rest = await renderOffline(tiny, { sampleRate: rate, duration: duration(128, rate), inputs: { controls: input }, restore: first.state });
  for (const snapshot of [first.state, rest.state]) {
    const slot = decodeSnapshot(snapshot).slots.find(s => s.name === 'source/scaledPhase')!;
    expect(new DataView(slot.data.buffer, slot.data.byteOffset, slot.data.byteLength).getFloat64(0, true) / 2 ** 1020).toBe(Number.MIN_VALUE);
  }
  expect(rest.outputs.main).toEqual(first.outputs.main);
});
test('full finite native PCM remains finite through simultaneous frame/band interpolation', async () => {
  const maximum = 3.4028234663852886e38, data = Float32Array.from({ length: 96 }, (_, i) => [maximum, -maximum, 1, -1, maximum, maximum, -maximum][i % 7]);
  const controls = [Float32Array.from({ length: 512 }, (_, i) => 48000 * .45 * i / 511), new Float32Array(512).fill(.4), new Float32Array(512)];
  const r = await renderOffline(processor(48000, 16, 2, .99), { sampleRate: 48000, duration: duration(512, 48000), inputs: { controls }, messages: [{ name: 'load', payload: { data } }] });
  const expected = bandsReference(data, 48000, 16, 2, controls, .99); let error = 0;
  r.outputs.main[0].forEach((x, i) => { expect(Number.isFinite(x)).toBe(true); error = Math.max(error, Math.abs(x - expected[i]) / maximum); });
  expect(error).toBeLessThan(1e-6); expect(r.diagnostics.scrubbedSamples).toBe(0);
});

test('tiny local phase survives nonzero frame and band offsets against large PCM', async () => {
  const rate = 48000, n = 128, size = 16, count = 2, data = new Float32Array(96);
  for (let cycle = 0; cycle < 6; cycle++) data[cycle * size + 1] = 3e38;
  for (const frame of [0, .5, 1]) for (const frequency of [0, 2000, 4000, 10000, 21600]) {
    const controls = constant(n, frequency, frame); controls[2].fill(1);
    const r = await renderOffline(processor(rate, size, count, 1e-40), { sampleRate: rate, duration: duration(n, rate), inputs: { controls }, messages: [{ name: 'load', payload: { data } }] });
    close(r.outputs.main[0], bandsReference(data, rate, size, count, controls, 1e-40), 1e-7);
    expect(r.outputs.main[0][0]).toBeCloseTo(Math.fround(16e-40 * data[1]), 7); expect(r.diagnostics.scrubbedSamples).toBe(0);
  }
});
