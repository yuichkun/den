import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compile, decodeSnapshot } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import { makeProcessor } from './processor.ts';
import { energy, freezeReference, maxError, ports } from './reference.ts';
function storedEnergy(state: Uint8Array) {
  return decodeSnapshot(state).slots.filter(s => s.kind === 'buffer').reduce((sum, slot) => {
    const view = new DataView(slot.data.buffer, slot.data.byteOffset, slot.data.byteLength);
    for (let i = 0; i < slot.data.byteLength; i += 8) { const x = view.getFloat64(i, true) / 2 ** 256; sum += x * x; }
    return sum;
  }, 0);
}
const reports: object[] = [];
for (const sampleRate of [44100, 48000, 96000]) {
  const frames = Math.ceil(sampleRate * 2 / 128) * 128, config = { roomScale: .75, decaySeconds: .6, transitionSamples: 257 };
  const data = ports(frames, {
    0: n => n < sampleRate / 5 ? .2 * Math.cos(2 * Math.PI * 211 * n / sampleRate) + .1 * Math.sin(2 * Math.PI * 619 * n / sampleRate) : 0,
    1: n => n < sampleRate / 5 ? .2 * Math.sin(2 * Math.PI * 317 * n / sampleRate) : 0,
    2: n => Number(n >= sampleRate / 4 && n < sampleRate * 1.25),
  });
  const captureStart = performance.now(), processor = makeProcessor(config), captureMs = performance.now() - captureStart;
  const compileStart = performance.now(), compiled = await compile(processor, { sampleRate }), compileMs = performance.now() - compileStart;
  const driver = await compiled.driver.instantiate(), memoryBytes = driver.memory.buffer.byteLength;
  const output = Array.from({ length: 4 }, () => new Float32Array(frames)), timings: number[] = [];
  for (let offset = 0; offset < frames; offset += 128) {
    for (const [channel, source] of [[0, 0], [1, 1], [2, 3]]) driver.writeInput('main', channel, data[source].slice(offset, offset + 128));
    driver.writeParam('freeze', data[2].slice(offset, offset + 128));
    const start = performance.now(); driver.process(); timings.push(performance.now() - start);
    output.forEach((channel, i) => { const block = new Float32Array(128); driver.readOutput('main', i, block); channel.set(block, offset); });
  }
  const expected = freezeReference(data, { ...config, sampleRate }), errors = output.map((channel, i) => maxError(channel, expected[i]));
  assert(errors.every(error => error < 3e-7), `independent timeline oracle ${sampleRate}: ${errors}`);
  assert.equal(driver.scrubbedSamples(), 0); assert.equal(driver.memory.buffer.byteLength, memoryBytes);
  assert(output.every(channel => channel.every(Number.isFinite)));
  const offline = (start: number, end: number, restore?: Uint8Array) => renderOffline(processor, {
    sampleRate, duration: (end - start - .25) / sampleRate,
    inputs: { main: [data[0].slice(start, end), data[1].slice(start, end), data[3].slice(start, end)] },
    params: { freeze: Array.from(data[2].slice(start, end)) }, restore,
  });
  const split = Math.ceil(sampleRate * .55 / 128) * 128, whole = await offline(0, frames), first = await offline(0, split), continued = await offline(split, frames, first.state);
  output.forEach((channel, i) => { assert.deepEqual(channel, whole.outputs.main[i]); assert.deepEqual(channel.slice(split), continued.outputs.main[i]); });
  assert.equal(first.outputs.main[3].at(-1), 1);
  assert.equal(whole.diagnostics.scrubbedSamples, 0); assert.equal(continued.diagnostics.scrubbedSamples, 0);
  const freezeFrames = 262144, held = await renderOffline(processor, {
    sampleRate, duration: (freezeFrames - .25) / sampleRate,
    params: { freeze: Array<number>(freezeFrames).fill(1) }, restore: first.state,
  });
  assert(held.outputs.main[2].every(x => x === 1)); assert(held.outputs.main[3].every(x => x === 1));
  const heldParam = decodeSnapshot(held.state).slots.find(s => s.kind === 'param' && s.name === 'freeze');
  assert(heldParam); assert.equal(new DataView(heldParam.data.buffer, heldParam.data.byteOffset, heldParam.data.byteLength).getFloat32(0, true), 1);
  const initialStoredEnergy = storedEnergy(first.state), finalStoredEnergy = storedEnergy(held.state);
  const relativeStoredEnergyDrift = Math.abs(finalStoredEnergy / initialStoredEnergy - 1);
  assert(initialStoredEnergy > 0); assert(relativeStoredEnergyDrift < 2e-10);
  assert.equal(held.diagnostics.scrubbedSamples, 0);
  const slots = decodeSnapshot(first.state).slots;
  assert.equal(slots.filter(s => s.kind === 'buffer').length, 4);
  const candidate = `candidate-freeze-tail-${sampleRate}.wav`;
  writeFileSync(candidate, encodeWav(output.slice(0, 2), sampleRate));
  const coldQuantumMs = timings[0], warm = timings.slice(1).sort((a, b) => a - b);
  reports.push({ sampleRate, frames, config, candidate, maxOracleErrors: errors,
    captureMs, compileMs, wasmBytes: compiled.wasm.byteLength, wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'),
    graphBytes: JSON.stringify(compiled.graph).length, memoryBytes, coldQuantumMs, warmP50Ms: warm[Math.floor(warm.length / 2)], warmMaxMs: warm.at(-1),
    quantumBudgetMs: 128000 / sampleRate, measuredQuanta: timings.length, observedDeadlineExceedances: timings.filter(ms => ms > 128000 / sampleRate).length,
    freezeFrames, initialStoredEnergy, finalStoredEnergy, relativeStoredEnergyDrift, snapshotBytes: first.state.byteLength, snapshotSplit: split, snapshotContinuation: 'bit-identical with all four nonzero delay histories and frozen mode',
    snapshotBufferBytes: slots.filter(s => s.kind === 'buffer').reduce((sum, s) => sum + s.data.byteLength, 0),
    parameterEdits: 'Native a-rate freeze control; excitation and loss ramp into and out of freeze',
    stereoEnergy: energy(output), maxOutputMagnitude: output.slice(0, 2).reduce((m, c) => c.reduce((s, v) => Math.max(s, Math.abs(v)), m), 0),
    scrubbedSamples: 0, limitation: 'Local Node process timing excludes input/output copies; no browser/hardware realtime deadline claim' });
}
const maximumStart = performance.now(), maximumCompiled = await compile(makeProcessor({ roomScale: 2, transitionSamples: 0 }), { sampleRate: 192000 });
const maximumCompileMs = performance.now() - maximumStart, maximumDriver = await maximumCompiled.driver.instantiate();
const maximumMemoryBytes = maximumDriver.memory.buffer.byteLength, lengths = [297, 371, 411, 437].map(x => Math.round(x / 10000 * 2 * 192000));
const frames = 18432, input = ports(frames, { 0: n => Number(n === 0), 2: n => Number(n >= 1) });
const expected = freezeReference(input, { sampleRate: 192000, roomScale: 2, transitionSamples: 0 });
let maximumError = 0;
for (let offset = 0; offset < frames; offset += 128) {
  maximumDriver.writeInput('main', 0, input[0].slice(offset, offset + 128));
  maximumDriver.writeParam('freeze', input[2].slice(offset, offset + 128));
  maximumDriver.process();
  for (let ch = 0; ch < 4; ch++) { const block = new Float32Array(128); maximumDriver.readOutput('main', ch, block); maximumError = Math.max(maximumError, maxError(block, expected[ch].slice(offset, offset + 128))); }
}
assert.equal(maximumError, 0); assert.equal(maximumDriver.memory.buffer.byteLength, maximumMemoryBytes); assert.equal(maximumDriver.scrubbedSamples(), 0);
const maximumCapacity = { sampleRate: 192000, roomScale: 2, delayLengths: lengths, historyValues: lengths.reduce((s, n) => s + n, 0), historyBytes: lengths.reduce((s, n) => s + 8 * n, 0),
  nativeMemoryBytes: maximumMemoryBytes, compileMs: maximumCompileMs, wasmBytes: maximumCompiled.wasm.byteLength,
  wasmSha256: createHash('sha256').update(maximumCompiled.wasm).digest('hex'), checkedFrames: frames,
  memoryGrowthBytes: 0, maxOracleError: maximumError, scrubbedSamples: 0, maximumProcessRssBytes: process.resourceUsage().maxRSS * 1024,
  limitation: 'Fixed maximum allocation and every first-arrival impulse checked; no maximum-capacity realtime certification' };
writeFileSync('freeze-reverb-results.json', JSON.stringify({ status: 'CANDIDATE', musicalVerdict: 'NOT_CLEARED', reports, maximumCapacity }, null, 2));
console.log(JSON.stringify({ reports, maximumCapacity }));
