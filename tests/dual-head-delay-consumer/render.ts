import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compile } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import { makeProcessor } from './processor.ts';
import { channels, dualHeadDelayReference, maxError } from './reference.ts';
const reports: object[] = [];
for (const sampleRate of [44100, 48000, 96000]) {
  const frames = 8192, transition = 257;
  const ports = channels(frames, sampleRate, {
    0: n => n < 6144 ? .5 * Math.sin(2 * Math.PI * n / 64) + .125 * Math.cos(2 * Math.PI * n / 17) : 0,
    1: n => (n < 120 ? 8 : n < 127 ? 72.25 : n < 300 ? 24.5 : n < 1024 ? 113.75 : n < 2048 ? 8 : n < 3072 ? 96 : 1 + (n * 17) % 127) / sampleRate,
    2: n => n === 2049 || (n >= 5000 && n <= 5003) ? 1 : 0,
    4: n => n < 4096 ? 1 : (n % 97) / 96,
  });
  const captureStart = performance.now(), processor = makeProcessor(transition), captureMs = performance.now() - captureStart;
  const compileStart = performance.now(), compiled = await compile(processor, { sampleRate }), compileMs = performance.now() - compileStart;
  const driver = await compiled.driver.instantiate(), memoryBytes = driver.memory.buffer.byteLength;
  const output = Array.from({ length: 4 }, () => new Float32Array(frames)), timings: number[] = [];
  for (let offset = 0; offset < frames; offset += 128) {
    driver.writeInput('main', 0, ports[0].slice(offset, offset + 128));
    driver.writeInput('main', 1, ports[2].slice(offset, offset + 128));
    driver.writeParam('timeSeconds', ports[1].slice(offset, offset + 128));
    driver.writeParam('mix', ports[4].slice(offset, offset + 128));
    const start = performance.now(); driver.process(); timings.push(performance.now() - start);
    output.forEach((ch, j) => { const block = new Float32Array(128); driver.readOutput('main', j, block); ch.set(block, offset); });
  }
  const expected = dualHeadDelayReference(ports, { rate: sampleRate, capacity: 128, transition });
  const errors = output.map((ch, i) => maxError(ch, expected[i]));
  assert(errors.every(error => error < 3e-7), `timeline/queue oracle ${sampleRate}: ${errors}`);
  assert.equal(driver.scrubbedSamples(), 0); assert.equal(driver.memory.buffer.byteLength, memoryBytes);
  assert(output.every(ch => ch.every(Number.isFinite))); assert(output[0].slice(6272).every(x => x === 0));
  const offline = (start: number, end: number, restore?: Uint8Array) => renderOffline(processor, {
    sampleRate, duration: (end - start - .25) / sampleRate,
    inputs: { main: [ports[0].slice(start, end), ports[2].slice(start, end)] },
    params: { timeSeconds: Array.from(ports[1].slice(start, end)), mix: Array.from(ports[4].slice(start, end)) }, restore,
  });
  const whole = await offline(0, frames), first = await offline(0, 128), continued = await offline(128, frames, first.state);
  output.forEach((ch, i) => { assert.deepEqual(ch, whole.outputs.main[i]); assert.deepEqual(ch.slice(128), continued.outputs.main[i]); });
  assert.equal(whole.diagnostics.scrubbedSamples, 0); assert.equal(continued.diagnostics.scrubbedSamples, 0);
  const candidate = `candidate-dual-head-delay-${sampleRate}.wav`;
  writeFileSync(candidate, encodeWav([output[0], output[3]], sampleRate));
  const coldQuantumMs = timings[0], warm = timings.slice(1).sort((a, b) => a - b);
  reports.push({ sampleRate, frames, transitionSamples: transition, historyCapacitySamples: 128, candidate, maxOracleErrors: errors,
    captureMs, compileMs, wasmBytes: compiled.wasm.byteLength, wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'),
    graphBytes: JSON.stringify(compiled.graph).length, memoryBytes, coldQuantumMs, warmP50Ms: warm[Math.floor(warm.length / 2)], warmMaxMs: warm.at(-1),
    quantumBudgetMs: 128000 / sampleRate, measuredQuanta: timings.length, observedDeadlineExceedances: timings.filter(ms => ms > 128000 / sampleRate).length,
    snapshotBytes: first.state.byteLength, snapshotSplit: 128, snapshotContinuation: 'bit-identical during active fade with queued request',
    parameterEdits: 'Native a-rate timeSeconds and mix at every quantum, including per-sample rapid request coalescing',
    scrubbedSamples: 0, limitation: 'Local Node process timing excludes input/output copies; no browser/hardware real-time deadline claim' });
}
// Actual upper-bound allocation, including native driver overhead, remains fixed.
const maximumStart = performance.now(), maximumCompiled = await compile(makeProcessor(65536, 8), { sampleRate: 192000 });
const maximumCompileMs = performance.now() - maximumStart, maximumDriver = await maximumCompiled.driver.instantiate();
const maximumMemoryBytes = maximumDriver.memory.buffer.byteLength;
const maximumInput = new Float32Array(128).fill(Math.fround(1e-40)), maximumOutput = new Float32Array(128);
for (let block = 0; block < 16; block++) {
  maximumDriver.writeInput('main', 0, maximumInput);
  maximumDriver.writeParam('timeSeconds', new Float32Array(128).fill(1 / 192000));
  maximumDriver.process(); maximumDriver.readOutput('main', 0, maximumOutput);
  if (block) assert(maximumOutput.every(x => x === maximumInput[0]));
}
assert.equal(maximumDriver.memory.buffer.byteLength, maximumMemoryBytes); assert.equal(maximumDriver.scrubbedSamples(), 0);
const maximumCapacity = { sampleRate: 192000, maxDelaySeconds: 8, transitionSamples: 65536,
  historyValues: 1536002, historyBytes: 12288016, nativeMemoryBytes: maximumMemoryBytes, compileMs: maximumCompileMs,
  wasmBytes: maximumCompiled.wasm.byteLength, wasmSha256: createHash('sha256').update(maximumCompiled.wasm).digest('hex'),
  checkedBlocks: 16, memoryGrowthBytes: 0, scrubbedSamples: 0, maximumProcessRssBytes: process.resourceUsage().maxRSS * 1024,
  limitation: 'Fixed allocation/tiny-signal smoke, not an eight-second tail, capacity-performance or realtime certification' };
writeFileSync('dual-head-delay-results.json', JSON.stringify({ status: 'CANDIDATE', reports, maximumCapacity }, null, 2));
console.log(JSON.stringify({ reports, maximumCapacity }));
