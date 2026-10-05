import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compile } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import { makeProcessor } from './processor.ts';
import { stretchBin, stretchMaxError, stretchPorts, stretchReference, stretchRows, type StretchRow } from './reference.ts';
const reports: object[] = [];
for (const rate of [44100, 48000, 96000]) {
  const sourceRate = 32000, pcm = Float32Array.from({ length: 4096 }, (_, n) => .4 * Math.cos(2 * Math.PI * n / 127.3) + .15 * Math.sin(n * .311));
  const frames = 8192, rows = stretchRows(frames, n => ({ durationScale: n < 3000 ? 1.31 : .77, pitchRatio: n < 3000 ? .83 : 1.47, trigger: n === 333 || n === 3001 || n >= 6100 && n < 6410, reset: n >= 5087 && n <= 5095, gate: n !== 2049 }));
  const captureStart = performance.now(), processor = makeProcessor(sourceRate), captureMs = performance.now() - captureStart;
  const compileStart = performance.now(), compiled = await compile(processor, { sampleRate: rate }), compileMs = performance.now() - compileStart;
  const driver = await compiled.driver.instantiate(), memoryBytes = driver.memory.buffer.byteLength, times: number[] = [];
  const controlPorts = stretchPorts(rows);
  for (let at = 0; at < frames; at += 128) {
    for (let j = 0; j < 3; j++) driver.writeInput('controls', j, controlPorts[j].slice(at, at + 128));
    driver.writeParam('durationScale', controlPorts[3].slice(at, at + 128)); driver.writeParam('pitchRatio', controlPorts[4].slice(at, at + 128));
    const start = performance.now(); driver.process(); times.push(performance.now() - start);
  }
  assert.equal(driver.memory.buffer.byteLength, memoryBytes); assert.equal(driver.scrubbedSamples(), 0);
  const render = (r: StretchRow[], restore?: Uint8Array) => renderOffline(processor, { sampleRate: rate, duration: (r.length - .25) / rate, inputs: { controls: stretchPorts(r).slice(0, 3) }, params: { durationScale: r.map(x => x.durationScale), pitchRatio: r.map(x => x.pitchRatio) }, ...(restore ? { restore } : { messages: [{ name: 'load', payload: { data: pcm } }] }) });
  const whole = await render(rows), prefix = await render(rows.slice(0, 384)), rest = await render(rows.slice(384), prefix.state);
  const expected = stretchReference(rows, [{ at: 0, data: pcm }], rate, sourceRate);
  const errors = whole.outputs.main.map((channel, j) => stretchMaxError(channel, expected[j]));
  assert(errors.every(e => e < 3e-7), `independent native oracle at ${rate}: ${errors}`);
  assert.deepEqual(rest.outputs.main, whole.outputs.main.map(c => c.slice(384)));
  assert.equal(whole.diagnostics.scrubbedSamples, 0); assert.equal(rest.diagnostics.scrubbedSamples, 0);
  // Independent signal evidence: doubling duration keeps carrier frequency,
  // changing pitch to 2 doubles frequency but not total output count.
  const tone = Float32Array.from({ length: 4096 }, (_, n) => .5 * Math.cos(2 * Math.PI * n / 128)), signalChecks = [];
  for (const pitchRatio of [1, 2]) {
    const signalProcessor = makeProcessor(rate), signalRows = stretchRows(8448, () => ({ durationScale: 2, pitchRatio }));
    const signal = await renderOffline(signalProcessor, { sampleRate: rate, duration: (8448 - .25) / rate, inputs: { controls: stretchPorts(signalRows).slice(0, 3) }, params: { durationScale: signalRows.map(() => 2), pitchRatio: signalRows.map(() => pitchRatio) }, messages: [{ name: 'load', payload: { data: tone } }] });
    const [audio, active] = signal.outputs.main;
    assert(active.slice(0, 8192).every(v => v === 1)); assert(active.slice(8192).every(v => v === 0)); assert(audio.slice(8192).every(v => v === 0));
    const targetAmplitude = stretchBin(audio.slice(1024, 5120), pitchRatio / 128);
    assert(targetAmplitude > .4998); assert(audio.findLastIndex(v => Math.abs(v) > 1e-6) > 8192 - 512);
    if (pitchRatio === 2) assert(stretchBin(audio.slice(1024, 5120), 1 / 128) < 2e-6);
    const candidate = `candidate-resident-time-stretch-${rate}-duration2-pitch${pitchRatio}.wav`;
    writeFileSync(candidate, encodeWav([audio], rate)); signalChecks.push({ pitchRatio, durationScale: 2, outputFrames: 8192, targetCyclesPerOutputSample: pitchRatio / 128, targetAmplitude, candidate });
  }
  const candidate = `candidate-resident-time-stretch-${rate}-edits.wav`; writeFileSync(candidate, encodeWav([whole.outputs.main[0]], rate));
  const warm = times.slice(1).sort((a, b) => a - b);
  reports.push({ rate, sourceRate, frames, candidate, signalChecks, maxOracleErrors: errors, captureMs, compileMs, graphBytes: JSON.stringify(compiled.graph).length, wasmBytes: compiled.wasm.length, wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'), memoryBytes, memoryGrowthBytes: 0, coldQuantumMs: times[0], warmP50Ms: warm[Math.floor(warm.length / 2)], warmMaxMs: warm.at(-1), observedDeadlineExceedances: times.filter(t => t > 128000 / rate).length, quantumBudgetMs: 128000 / rate, snapshotBytes: prefix.state.length, snapshotSplit: 384, snapshotContinuation: 'Bit-identical mid-H256 hop with queued trigger and resident data', scrubbedSamples: 0, limitation: 'Timing is unloaded public driver search; actual loaded native rendering and timing are distinct. Not realtime or browser evidence.' });
}
// Maximum native resident capacity and comparison radius. Search still runs
// while unloaded, so this tests its fixed work/memory without private ingress.
const maximumStart = performance.now(), maximum = await compile(makeProcessor(8000, 65536, 256, 128), { sampleRate: 192000 }), maximumCompileMs = performance.now() - maximumStart;
const driver = await maximum.driver.instantiate(), memoryBytes = driver.memory.buffer.byteLength, timings: number[] = [];
for (let n = 0; n < 128; n++) { const start = performance.now(); driver.process(); timings.push(performance.now() - start); }
assert.equal(driver.memory.buffer.byteLength, memoryBytes); assert.equal(driver.scrubbedSamples(), 0);
// Real maximum-size resident load, not an allocation-only proof.
const maximumPcm = new Float32Array(65536).fill(Math.fround(1e-40)), maximumRows = stretchRows(1024, () => ({ durationScale: 2, pitchRatio: .5 }));
const loaded = await renderOffline(makeProcessor(8000, 65536, 256, 128), { sampleRate: 192000, duration: (1024 - .25) / 192000, inputs: { controls: stretchPorts(maximumRows).slice(0, 3) }, params: { durationScale: maximumRows.map(() => 2), pitchRatio: maximumRows.map(() => .5) }, messages: [{ name: 'load', payload: { data: maximumPcm } }] });
assert(loaded.outputs.main[0].every(x => x === maximumPcm[0])); assert.equal(loaded.diagnostics.scrubbedSamples, 0);
const maximumCapacity = { sourceRate: 8000, outputRate: 192000, residentFrames: 65536, ingressSlots: 16, hopSamples: 256, searchFrames: 128, comparisonsPerQuantum: 257 * 64, comparisonValues: 64, memoryBytes, memoryGrowthBytes: 0, compileMs: maximumCompileMs, graphBytes: JSON.stringify(maximum.graph).length, wasmBytes: maximum.wasm.length, coldQuantumMs: timings[0], warmMaxMs: Math.max(...timings.slice(1)), maxProcessRssBytes: process.resourceUsage().maxRSS * 1024, loadedMaximumFrames: 65536, exactSubnormalOutputFrames: 1024, scrubbedSamples: 0, limitation: 'Fixed maximum allocation and loaded PCM proof, not realtime certification; stopped search executes every128 samples.' };
writeFileSync('resident-time-stretch-results.json', JSON.stringify({ status: 'CANDIDATE', reports, maximumCapacity }, null, 2));
console.log(JSON.stringify({ reports, maximumCapacity }));
