// Native entry proof only: this does not validate IR provenance or implement DSP.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { audioOutput, bool, CAPACITY_16, compile, decodeSnapshot, decodeTypedArray, defineProcessor, event, f32, forSample, i32, select, state } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { spectralForEach } from '../../dist/spectral-fft.js';

const block = 128, size = 256, partitions = 64, values = 2 * size * partitions;
const payloadCapacity = values * 8;
const processor = defineProcessor(() => {
  const table = state.buffer.f64({ size: values }).expose({ name: 'table', snapshot: 'persistent' });
  const loaded = state.bool(false).named('loaded'), rejected = state.bool(false).named('rejected');
  const revision = state.i32(0).named('revision'), length = state.i32(0).named('length');
  const declared = state.f32(0).named('declared'), scanned = state.i32(0).named('scanned');
  const bad = state.bool(false).expose({ name: 'bad', snapshot: 'transient' });
  const clock = state.i32(0).named('clock');
  const ingress = event({ from: 'main', name: 'spectrum', capacity: CAPACITY_16, payloadCapacity });
  ingress.onReceive(p => {
    table.copyFrom(p.spectrum);
    length.write(p.spectrum.length); declared.write(p.declaredValues);
    const header = p.formatVersion.eq(1).and(p.blockSize.eq(block)).and(p.partitions.eq(partitions));
    const complete = header.and(p.impulseFrames.gte(1)).and(p.impulseFrames.lte(block * partitions)).and(p.impulseFrames.floor().eq(p.impulseFrames))
      .and(p.declaredValues.eq(values)).and(length.read().eq(values));
    const unload = header.and(p.impulseFrames.eq(0)).and(p.declaredValues.eq(0)).and(length.read().eq(0));
    bad.write(false); scanned.write(0);
    spectralForEach(partitions, partition => spectralForEach(size, bin => {
      const index = partition.mul(size).add(bin).mul(2);
      const real = table.read(index), imag = table.read(index.add(1));
      bad.write(bad.read().or(real.eq(real).not()).or(imag.eq(imag).not()).or(real.abs().gt(4 + 1e-9)).or(imag.abs().gt(4 + 1e-9)));
      scanned.write(scanned.read().add(2));
    }));
    loaded.write(complete.and(bad.read().not()));
    rejected.write(loaded.read().not().and(unload.not()));
    revision.write(revision.read().add(1));
  });
  const output = audioOutput({ channels: 8, name: 'main' });
  return { process() { forSample(i => {
    [select(loaded.read(), f32(1), f32(0)), select(rejected.read(), f32(1), f32(0)), f32(revision.read()), f32(length.read()),
      declared.read(), f32(scanned.read()), select(loaded.read(), f32(table.read(values - 1)), f32(0)), f32(clock.read())]
      .forEach((value, channel) => output.ch(channel).at(i).write(value));
    clock.write(clock.read().add(1));
  }); } };
}, { id: 'den.prepared-convolution.native-ingress-probe.v1' });

const data = Float64Array.from({ length: values }, (_, n) => Math.sin(n * 0.037) * 0.25 + n * 2 ** -45);
const packet = spectrum => ({ formatVersion: 1, blockSize: block, partitions, impulseFrames: block * partitions, declaredValues: spectrum.length, spectrum });
const message = (payload, atQuantum = 0) => ({ name: 'spectrum', payload, atQuantum });
const render = (rate, frames, messages = [], restore) => renderOffline(processor, { sampleRate: rate, duration: (frames - 0.25) / rate, messages, restore });
const reports = [];
for (const rate of [44100, 48000, 96000]) {
  const good = await render(rate, 128, [message(packet(data))]);
  const probeCopy = decodeTypedArray('f64', decodeSnapshot(good.state).slots.find(slot => slot.name === 'table').data);
  console.error(JSON.stringify({ stage: 'first-packet', sampleRate: rate, firstSamples: good.outputs.main.map(channel => channel[0]),
    fields: processor.worklet.messageRings[0].fields,
    copiedF64Mismatches: probeCopy.reduce((count, value, n) => count + Number(value !== data[n]), 0) }));
  assert.equal(good.diagnostics.scrubbedSamples, 0);
  assert.equal(good.outputs.main[0][0], 1); assert.equal(good.outputs.main[1][0], 0);
  assert.equal(good.outputs.main[2][0], 1); assert.equal(good.outputs.main[3][0], values);
  assert.equal(good.outputs.main[4][0], values); assert.equal(good.outputs.main[5][0], values);
  assert.equal(good.outputs.main[6][0], Math.fround(data.at(-1)));
  assert.deepEqual(good.outputs.main[7], Float32Array.from({ length: 128 }, (_, n) => n));
  const copied = decodeSnapshot(good.state).slots.find(slot => slot.name === 'table');
  assert(copied); assert.deepEqual(decodeTypedArray('f64', copied.data), data);
  const restored = await render(rate, 128, [], good.state);
  for (let ch = 0; ch < 7; ch++) assert.deepEqual(restored.outputs.main[ch], good.outputs.main[ch]);
  assert.equal(restored.outputs.main[7][0], 128);

  const badNumber = data.slice(); badNumber[values - 1] = NaN;
  const tooLarge = data.slice(); tooLarge[values - 2] = Infinity;
  const outOfRange = data.slice(); outOfRange[values - 1] = 4.01;
  const oversized = new Float64Array(values + 1); oversized.set(data); oversized[values] = 0.5;
  const cases = [
    { ...packet(data), formatVersion: 2 }, { ...packet(data), blockSize: 64 }, { ...packet(data), partitions: 32 },
    { ...packet(data), impulseFrames: 8192.5 }, { ...packet(data), declaredValues: values - 1 },
    packet(data.slice(0, 7)), packet(badNumber), packet(tooLarge), packet(outOfRange), packet(oversized),
  ];
  for (const invalid of cases) {
    const result = await render(rate, 256, [message(packet(data)), message(invalid, 1)]);
    assert.equal(result.diagnostics.scrubbedSamples, 0);
    assert(result.outputs.main[0].slice(128).every(value => value === 0));
    assert(result.outputs.main[1].slice(128).every(value => value === 1));
    assert.equal(result.outputs.main[2][128], 2); assert.equal(result.outputs.main[5][128], values);
    assert(result.outputs.main[6].slice(128).every(value => value === 0));
    assert.equal(result.outputs.main[7][128], 128);
    if (invalid.spectrum === oversized) { assert.equal(result.outputs.main[3][128], values); assert.equal(result.outputs.main[4][128], values + 1); }
  }
  const unloaded = await render(rate, 256, [message(packet(data)), message({ ...packet(new Float64Array()), impulseFrames: 0 }, 1)]);
  assert.equal(unloaded.outputs.main[0][128], 0); assert.equal(unloaded.outputs.main[1][128], 0); assert.equal(unloaded.outputs.main[2][128], 2);
  const queued = await render(rate, 128, Array.from({ length: 16 }, () => message(packet(data))));
  assert.equal(queued.outputs.main[2][0], 16); assert.equal(queued.outputs.main[0][0], 1); assert.equal(queued.diagnostics.scrubbedSamples, 0);
  reports.push({ sampleRate: rate, completeFloat64Values: values, byteExactCopy: true, invalidCases: cases.length, maximumQueuedLoads: 16, scanCountPerLoad: values, metadataAndClockIntegrity: true, snapshotContinuation: true });
}
const started = performance.now(), compiled = await compile(processor, { sampleRate: 48000 });
const instance = await compiled.driver.instantiate(), memoryBytes = instance.memory.buffer.byteLength;
instance.process(); assert.equal(instance.memory.buffer.byteLength, memoryBytes); assert.equal(instance.scrubbedSamples(), 0);
assert.equal(processor.worklet.messageRings[0].capacity, 16);
assert.equal(processor.worklet.messageRings[0].payloadContent.capacity, payloadCapacity * 16);
const result = { status: 'CANDIDATE native ingress only', reports, payloadBytesPerSlot: payloadCapacity, payloadRingBytes: payloadCapacity * 16,
  fixedMemoryBytes: memoryBytes, wasmBytes: compiled.wasm.byteLength, finalCompileInstantiateMs: performance.now() - started, maxProcessRssBytes: process.resourceUsage().maxRSS * 1024,
  limitations: ['Not IR, L1, symmetry or zero-padding validation', 'Oversized original length only detectable when independently declared honestly', 'No isolated copy/scan timing or realtime claim'] };
writeFileSync('artifacts/convolution-spectrum-ingress.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
