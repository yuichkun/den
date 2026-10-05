import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { compile } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { makeProcessor } from './processor.ts';

// First compilation/process in this fresh Node process, before offline renders.
const started = performance.now(), compiled = await compile(makeProcessor(512), { sampleRate: 48000 });
const compileMs = performance.now() - started, instance = await compiled.driver.instantiate();
const memoryBytes = instance.memory.buffer.byteLength;
const block = Float32Array.from({ length: 128 }, (_, n) => Math.sin(n * 0.13) * 0.5), zero = new Float32Array(128), output = new Float32Array(128);
instance.writeInput('main', 0, block); instance.writeInput('main', 1, zero);
const coldStart = performance.now(); instance.process(); const coldQuantumMs = performance.now() - coldStart;
const startup = [coldQuantumMs], times = [];
for (let n = 0; n < 127; n++) { const t = performance.now(); instance.process(); startup.push(performance.now() - t); }
for (let n = 0; n < 512; n++) {
  const t = performance.now(); instance.writeInput('main', 0, block); instance.writeInput('main', 1, zero); instance.process(); instance.readOutput('main', 0, output); times.push(performance.now() - t);
}
assert.equal(instance.memory.buffer.byteLength, memoryBytes); assert.equal(instance.scrubbedSamples(), 0);
times.sort((a, b) => a - b);
const cost = { sampleRate: 48000, size: 1024, frameHop: 512, executionDispatch: 128, compileMs, coldQuantumMs, startupMaxQuantumMs: Math.max(...startup),
  wasmBytes: compiled.wasm.byteLength, wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'), memoryBytes,
  warmupBlocks: 128, measuredBlocks: 512, copyBytesPerQuantum: 1536, p50Ms: times[256], p99Ms: times[506], maxMs: times.at(-1),
  includesInputOutputCopies: true, limitation: 'Fresh local Node driver; eager FFT every128 samples. Not browser/realtime/concurrency acceptance.' };

const reports = [];
for (const rate of [44100, 48000, 96000]) for (const hop of [256, 512]) {
  const frames = 32768, size = 1024;
  const input = Float32Array.from({ length: frames }, (_, n) => n < frames - size ? 0.4 * Math.sin(n * 0.0637) + 0.25 * Math.cos(n * 0.217) : 0);
  input[0] = 1; input[127] = -1; input[128] = 0.75;
  const reset = new Float32Array(frames); reset[511] = 1; reset[5247] = 1; reset.fill(1, 8191, 8196); reset[16384] = 1;
  const p = makeProcessor(hop);
  const render = (start, end, restore) => renderOffline(p, { sampleRate: rate, duration: (end - start - 0.25) / rate, inputs: { main: [input.slice(start, end), reset.slice(start, end)] }, restore });
  const result = await render(0, frames); let start = 0, maxError = 0;
  for (let n = 0; n < frames; n++) {
    if (reset[n]) start = n + 1;
    const expected = n - size >= start ? input[n - size] : 0;
    maxError = Math.max(maxError, Math.abs(expected - result.outputs.main[0][n]));
  }
  assert(maxError < 1.5e-7); assert.equal(result.diagnostics.scrubbedSamples, 0);
  for (const offset of [128, 256, 384, 512]) {
    const split = 5120 + offset, first = await render(0, split), resumed = await render(split, frames, first.state);
    assert.deepEqual(resumed.outputs.main[0], result.outputs.main[0].slice(split));
    assert.equal(resumed.diagnostics.scrubbedSamples, 0);
  }
  reports.push({ sampleRate: rate, size, hop, frames, latencySamples: size, maxIdentityError: maxError, snapshotPhaseOffsets: [128, 256, 384, 512], snapshotContinuation: 'bit-identical', scrubbedSamples: 0 });
}
cost.maxProcessRssBytes = process.resourceUsage().maxRSS * 1024;
writeFileSync('spectral-large-results.json', JSON.stringify({ status: 'CANDIDATE', reports, cost }, null, 2));
console.log(JSON.stringify({ reports, cost }));
