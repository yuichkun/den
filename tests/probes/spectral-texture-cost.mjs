// After npm run build, run each mode separately under the coordinator's guard:
// node tests/probes/spectral-texture-cost.mjs blur (or cross)
// Local loaded native cost only. No browser or real-time acceptance is implied.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { audioInput, audioOutput, compile, defineProcessor, forSample, instantiate } from '@unworklet/core';
import { spectralBlur, spectralCrossSynthesis } from '../../dist/spectral-texture.js';

const mode = process.argv[2]; assert(['blur', 'cross'].includes(mode));
const size = 256, hopSize = 64, captureStart = performance.now();
const processor = defineProcessor(() => {
  const input = audioInput({ channels: 4, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
  const unit = instantiate(mode === 'blur' ? spectralBlur : spectralCrossSynthesis, { size, hopSize, radius: 8, maxGain: 16 }, { name: 'unit' });
  return { process() { forSample((i, every) => {
    const carrier = input.ch(0).at(i), modulator = input.ch(1).at(i), amount = input.ch(2).at(i), reset = input.ch(3).at(i).gt(0);
    output.ch(0).at(i).write(mode === 'blur' ? unit.tick(carrier, amount, reset, every) : unit.tick(carrier, modulator, amount, reset, every));
  }); } };
});
const captureMs = performance.now() - captureStart, compileStart = performance.now();
console.error(JSON.stringify({ stage: 'captured', mode, captureMs, rssBytes: process.memoryUsage().rss }));
const compiled = await compile(processor, { sampleRate: 48000 }), compileMs = performance.now() - compileStart;
const instance = await compiled.driver.instantiate(), memoryBytes = instance.memory.buffer.byteLength;
console.error(JSON.stringify({ stage: 'compiled', mode, compileMs, wasmBytes: compiled.wasm.byteLength, memoryBytes }));
const input = [Float32Array.from({ length: 128 }, (_, n) => Math.sin(n * 0.13) * 0.5), Float32Array.from({ length: 128 }, (_, n) => Math.cos(n * 0.31) * 0.7), new Float32Array(128).fill(1), new Float32Array(128)];
const output = new Float32Array(128), startup = [], measured = [];
for (let quantum = 0; quantum < 640; quantum++) {
  const started = performance.now();
  input.forEach((values, ch) => instance.writeInput('main', ch, values));
  instance.process(); instance.readOutput('main', 0, output);
  (quantum < 128 ? startup : measured).push(performance.now() - started);
  assert(output.every(Number.isFinite));
}
assert(output.some(x => x !== 0)); assert.equal(instance.scrubbedSamples(), 0); assert.equal(instance.memory.buffer.byteLength, memoryBytes);
const stats = times => { const ordered = [...times].sort((a, b) => a - b); return { count: times.length, p50Ms: ordered[Math.floor(times.length * .5)], p99Ms: ordered[Math.floor(times.length * .99)], maxMs: ordered.at(-1) }; };
console.log(JSON.stringify({ status: 'CANDIDATE', mode, size, hopSize, radius: mode === 'blur' ? 8 : null, maxGain: mode === 'cross' ? 16 : null,
  sampleRate: 48000, node: process.version, unworklet: '0.4.1', captureMs, compileMs, coldQuantumMs: startup[0],
  startup: stats(startup), warm: stats(measured), includesInputOutputCopies: true, copyBytesPerQuantum: 2560,
  memoryBytes, wasmBytes: compiled.wasm.byteLength, wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'),
  graphBytes: JSON.stringify(compiled.graph).length, peakProcessRssBytes: process.resourceUsage().maxRSS * 1024, scrubbedSamples: 0,
  limitation: 'One loaded local Node driver with fixed memory. Wall time includes host jitter; no browser, deadline, concurrency or sound-quality clearance.' }));
