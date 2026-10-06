import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compile, decodeSnapshot } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import { makeProcessor } from './processor.ts';
import { spatialPorts as ports, spatialReference, maxError } from './reference.ts';

const reports = [], audio = [], sourceChannels = [0, 2, 3, 6];
const expectedChannels = (data, rate, mode, width) => {
  const result = spatialReference(data, rate, mode === 'pitched' ? width : undefined).output;
  return mode === 'hybrid' ? [...result, new Float32Array(data[0].length)] : result;
};
for (const sampleRate of [44100, 48000, 96000]) {
  const frames = 32768, width = 512;
  const data = ports(frames, {
    0: n => n < 25000 ? .3 * Math.sin(n * .119) + .2 * Math.cos(n * .073) : 0,
    1: n => n < 4096 ? 0 : n < 8192 ? .5 : 1,
    2: n => Number(n >= 10000 && n < 14000),
    3: n => Number(n === 11001 || n >= 19001 && n < 19009),
    4: n => n < 8000 ? 2 : n < 17000 ? .625 : 1.5,
    5: n => n < 5000 ? 0 : n < 23000 ? .625 : 1,
    6: n => Number(n === 5301 || n >= 18000 && n < 18007 || n === 19002),
  });
  const candidateChannels = [data[0]];
  for (const mode of ['hybrid', 'pitched']) {
    const captureStart = performance.now(), processor = makeProcessor(mode, width), captureMs = performance.now() - captureStart;
    const compileStart = performance.now(), compiled = await compile(processor, { sampleRate }), compileMs = performance.now() - compileStart;
    const driver = await compiled.driver.instantiate(), memoryBytes = driver.memory.buffer.byteLength;
    const output = Array.from({ length: 3 }, () => new Float32Array(frames)), timings = [];
    for (let offset = 0; offset < frames; offset += 128) {
      const start = performance.now();
      sourceChannels.forEach((source, channel) => driver.writeInput('main', channel, data[source].slice(offset, offset + 128)));
      for (const [name, ch] of [['mix', 1], ['ratio', 4], ['pitchMix', 5]]) driver.writeParam(name, data[ch].slice(offset, offset + 128));
      driver.process();
      output.forEach((channel, ch) => { const block = new Float32Array(128); driver.readOutput('main', ch, block); channel.set(block, offset); });
      timings.push(performance.now() - start);
    }
    const expected = expectedChannels(data, sampleRate, mode, width), errors = output.map((channel, ch) => maxError(channel, expected[ch]));
    assert(errors.every(error => error < 1e-6), `independent ${mode} waveform ${sampleRate}: ${errors}`);
    assert(output.every(channel => channel.every(Number.isFinite))); assert.equal(driver.scrubbedSamples(), 0);
    assert.equal(driver.memory.buffer.byteLength, memoryBytes);
    const offline = (start, end, restore) => renderOffline(processor, {
      sampleRate, duration: (end - start - .25) / sampleRate,
      inputs: { main: sourceChannels.map(ch => data[ch].slice(start, end)) },
      params: { mix: Array.from(data[1].slice(start, end)), ratio: Array.from(data[4].slice(start, end)), pitchMix: Array.from(data[5].slice(start, end)) }, restore,
    });
    const split = 9856, whole = await offline(0, frames), head = await offline(0, split), continued = await offline(split, frames, head.state);
    assert.deepEqual(output, whole.outputs.main); assert.deepEqual(continued.outputs.main, output.map(ch => ch.slice(split)));
    assert.deepEqual(continued.state, whole.state);
    for (const result of [whole, head, continued]) assert.equal(result.diagnostics.scrubbedSamples, 0);
    const slots = decodeSnapshot(head.state).slots;
    assert.equal(slots.filter(s => s.kind === 'buffer').length, mode === 'hybrid' ? 11 : 13);
    for (const name of ['mix', 'ratio', 'pitchMix']) assert(slots.some(s => s.kind === 'param' && s.name === name));
    candidateChannels.push(...output.slice(0, 2));
    const warm = timings.slice(1).sort((a, b) => a - b);
    reports.push({ mode, sampleRate, windowSamples: mode === 'pitched' ? width : null, frames, maxOracleErrors: errors,
      captureMs, compileMs, graphBytes: JSON.stringify(compiled.graph).length, wasmBytes: compiled.wasm.byteLength,
      wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'), memoryBytes,
      coldQuantumMs: timings[0], warmP50Ms: warm[Math.floor(warm.length / 2)], warmP99Ms: warm[Math.floor(warm.length * .99)], warmMaxMs: warm.at(-1),
      measuredQuanta: timings.length, quantumBudgetMs: 128000 / sampleRate, deadlineMisses: timings.filter(ms => ms > 128000 / sampleRate).length,
      includesInputOutputCopies: true, copyBytesPerQuantum: 5120, snapshotBytes: head.state.byteLength, snapshotSplit: split,
      snapshotContinuation: 'bit-identical PCM and final serialized native state with noninitial early/late/pitch histories',
      maxOutputMagnitude: output.slice(0, 2).reduce((peak, channel) => channel.reduce((p, x) => Math.max(p, Math.abs(x)), peak), 0),
      scrubbedSamples: 0, limitation: 'Node functional/cost evidence, not browser/hardware realtime or listening clearance' });
  }
  const file = `candidate-spatial-chains-${sampleRate}.wav`, bytes = encodeWav(candidateChannels, sampleRate);
  writeFileSync(file, bytes);
  audio.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), sampleRate, frames,
    channels: ['original mono input', 'hybrid left', 'hybrid right', 'feedforward pitched left', 'feedforward pitched right'],
    normalization: 'none', status: 'CANDIDATE', humanApproved: false, windowSamples: width,
    inputEndsAt: 25000, tail: 'IIR tail continues; file end is not a claimed complete drain',
    controls: 'Native a-rate mix/ratio/pitchMix; explicit bypass, reset and retrigger probes as recorded in render.mjs' });
}

// Actual public maximum configuration: all first arrivals, including the initial
// W/2+1 pitched read delay, are inside this observation interval.
const sampleRate = 192000, windowSamples = 16384, frames = 32768;
const maximum = await compile(makeProcessor('pitched', windowSamples), { sampleRate });
const driver = await maximum.driver.instantiate(), memoryBytes = driver.memory.buffer.byteLength;
const data = ports(frames, { 0: n => Number(n === 0), 4: 1, 5: 1 });
const expected = expectedChannels(data, sampleRate, 'pitched', windowSamples), output = expected.map(x => new Float32Array(x.length));
for (let offset = 0; offset < frames; offset += 128) {
  sourceChannels.forEach((source, ch) => driver.writeInput('main', ch, data[source].slice(offset, offset + 128)));
  for (const [name, ch] of [['mix', 1], ['ratio', 4], ['pitchMix', 5]]) driver.writeParam(name, data[ch].slice(offset, offset + 128));
  driver.process();
  output.forEach((channel, ch) => { const block = new Float32Array(128); driver.readOutput('main', ch, block); channel.set(block, offset); });
}
const errors = output.map((channel, ch) => maxError(channel, expected[ch]));
assert(errors.every(error => error < 2e-7)); assert.equal(driver.scrubbedSamples(), 0);
assert.equal(driver.memory.buffer.byteLength, memoryBytes);
assert(output[0].slice(8193 + 5702, 8193 + 5705).some(x => x > .1));
const maximumCapacity = { sampleRate, windowSamples, frames, memoryBytes, wasmBytes: maximum.wasm.byteLength,
  wasmSha256: createHash('sha256').update(maximum.wasm).digest('hex'), maxOracleErrors: errors, memoryGrowthBytes: 0,
  pitchHistoryBytes: 16 * (windowSamples + 3), scrubbedSamples: 0, limitation: 'Maximum memory and arrival proof, no realtime certificate' };
const result = { status: 'CANDIDATE', musicalVerdict: 'NOT_CLEARED', reports, maximumCapacity, audio, maxProcessRssBytes: process.resourceUsage().maxRSS * 1024 };
writeFileSync('spatial-chains-results.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
