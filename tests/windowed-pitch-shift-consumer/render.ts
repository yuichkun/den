import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compile } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import { makeProcessor } from './processor.ts';
import { maxError, pitchReference, ports } from './reference.ts';
const reports: object[] = [];
for (const sampleRate of [44100, 48000, 96000]) {
  const frames = 16384, windowSamples = 512;
  const data = ports(frames, {
    0: n => n < 14336 ? .4 * Math.cos(2 * Math.PI * n / 128) + .15 * Math.sin(2 * Math.PI * n / 71) : 0,
    1: n => n < 3072 ? .75 : n < 4096 ? 1 : n < 6144 ? 1.5 : n < 8192 ? 2 : n < 10240 ? .5 : .5 + (n * 13 % 2048) / 2048 * 1.5,
    2: n => n === 8193 || n >= 12287 && n <= 12292 ? 1 : 0,
    3: n => n === 2049 || n === 8193 || n >= 11264 && n <= 11270 ? 1 : 0,
  });
  const mix = Float32Array.from({ length: frames }, (_, n) => n < 4096 ? 1 : (n % 97) / 96);
  const captureStart = performance.now(), processor = makeProcessor(windowSamples), captureMs = performance.now() - captureStart;
  const compileStart = performance.now(), compiled = await compile(processor, { sampleRate }), compileMs = performance.now() - compileStart;
  const driver = await compiled.driver.instantiate(), memoryBytes = driver.memory.buffer.byteLength;
  const output = Array.from({ length: 3 }, () => new Float32Array(frames)), timings: number[] = [];
  for (let offset = 0; offset < frames; offset += 128) {
    for (const [channel, source] of [[0, 0], [1, 2], [2, 3]]) driver.writeInput('main', channel, data[source].slice(offset, offset + 128));
    driver.writeParam('ratio', data[1].slice(offset, offset + 128)); driver.writeParam('mix', mix.slice(offset, offset + 128));
    const start = performance.now(); driver.process(); timings.push(performance.now() - start);
    output.forEach((channel, i) => { const block = new Float32Array(128); driver.readOutput('main', i, block); channel.set(block, offset); });
  }
  const expected = pitchReference(data, windowSamples);
  expected.push(Float32Array.from(data[0], (x, n) => x * (1 - mix[n]) + expected[0][n] * mix[n]));
  const errors = output.map((channel, i) => maxError(channel, expected[i]));
  assert(errors.every(error => error < 3e-7), `absolute timeline oracle ${sampleRate}: ${errors}`);
  assert.equal(driver.scrubbedSamples(), 0); assert.equal(driver.memory.buffer.byteLength, memoryBytes);
  assert(output.every(channel => channel.every(Number.isFinite)));
  assert(output[0].slice(14336 + windowSamples + 1).every(x => x === 0));
  const offline = (start: number, end: number, restore?: Uint8Array) => renderOffline(processor, {
    sampleRate, duration: (end - start - .25) / sampleRate,
    inputs: { main: [data[0].slice(start, end), data[2].slice(start, end), data[3].slice(start, end)] },
    params: { ratio: Array.from(data[1].slice(start, end)), mix: Array.from(mix.slice(start, end)) }, restore,
  });
  const split = 512, whole = await offline(0, frames), first = await offline(0, split), continued = await offline(split, frames, first.state);
  output.forEach((channel, i) => { assert.deepEqual(channel, whole.outputs.main[i]); assert.deepEqual(channel.slice(split), continued.outputs.main[i]); });
  assert.equal(whole.diagnostics.scrubbedSamples, 0); assert.equal(continued.diagnostics.scrubbedSamples, 0);
  const candidate = `candidate-windowed-pitch-shift-${sampleRate}.wav`;
  writeFileSync(candidate, encodeWav([data[0], output[0]], sampleRate));
  const coldQuantumMs = timings[0], warm = timings.slice(1).sort((a, b) => a - b);
  reports.push({ sampleRate, frames, windowSamples, candidate, maxOracleErrors: errors,
    captureMs, compileMs, wasmBytes: compiled.wasm.byteLength, wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'),
    graphBytes: JSON.stringify(compiled.graph).length, memoryBytes, coldQuantumMs, warmP50Ms: warm[Math.floor(warm.length / 2)], warmMaxMs: warm.at(-1),
    quantumBudgetMs: 128000 / sampleRate, measuredQuanta: timings.length, observedDeadlineExceedances: timings.filter(ms => ms > 128000 / sampleRate).length,
    snapshotBytes: first.state.byteLength, snapshotSplit: split, snapshotContinuation: 'bit-identical with nonzero moving phase/history',
    parameterEdits: 'Native a-rate ratio and consumer mix at every quantum, including per-sample ratio changes',
    scrubbedSamples: 0, limitation: 'Local Node process timing excludes input/output copies; no browser/hardware realtime deadline claim' });
}
// Render the real upper-bound allocation through its initial midpoint delay.
const maximumStart = performance.now(), maximumCompiled = await compile(makeProcessor(16384), { sampleRate: 192000 });
const maximumCompileMs = performance.now() - maximumStart, maximumDriver = await maximumCompiled.driver.instantiate();
const maximumMemoryBytes = maximumDriver.memory.buffer.byteLength;
const maximumInput = new Float32Array(128).fill(Math.fround(1e-40)), maximumOutput = new Float32Array(128);
for (let block = 0; block < 132; block++) {
  maximumDriver.writeInput('main', 0, maximumInput); maximumDriver.writeParam('ratio', new Float32Array(128).fill(1));
  maximumDriver.process(); maximumDriver.readOutput('main', 0, maximumOutput);
  for (let n = 0; n < 128; n++) assert.equal(maximumOutput[n], block * 128 + n < 8193 ? 0 : maximumInput[0]);
}
assert.equal(maximumDriver.memory.buffer.byteLength, maximumMemoryBytes); assert.equal(maximumDriver.scrubbedSamples(), 0);
const maximumCapacity = { sampleRate: 192000, windowSamples: 16384, historyValues: 16387, historyBytes: 131096,
  nativeMemoryBytes: maximumMemoryBytes, compileMs: maximumCompileMs, wasmBytes: maximumCompiled.wasm.byteLength,
  wasmSha256: createHash('sha256').update(maximumCompiled.wasm).digest('hex'), checkedBlocks: 132,
  memoryGrowthBytes: 0, scrubbedSamples: 0, maximumProcessRssBytes: process.resourceUsage().maxRSS * 1024,
  limitation: 'Fixed maximum allocation and exact tiny-signal unity delay; no maximum-capacity realtime certification' };
writeFileSync('windowed-pitch-shift-results.json', JSON.stringify({ status: 'CANDIDATE', reports, maximumCapacity }, null, 2));
console.log(JSON.stringify({ reports, maximumCapacity }));
