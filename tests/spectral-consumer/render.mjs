import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { compile } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { processor, impulse } from './processor.ts';

// Measure before any offline render so the first process call is genuinely cold
// in this fresh consumer process, rather than reusing already-rendered WASM.
const started = performance.now(), compiled = await compile(processor, { sampleRate: 48000 });
const compileMs = performance.now() - started;
const instance = await compiled.driver.instantiate(), memoryBytes = instance.memory.buffer.byteLength;
const input = Float32Array.from({ length: 128 }, (_, n) => Math.sin(n * 0.13) * 0.5), zero = new Float32Array(128), outputs = [new Float32Array(128), new Float32Array(128)];
instance.writeInput('main', 0, input); instance.writeInput('main', 1, zero);
const coldStart = performance.now(); instance.process(); const coldQuantumMs = performance.now() - coldStart;
const startupTimes = [coldQuantumMs];
for (let n = 0; n < 127; n++) { const start = performance.now(); instance.process(); startupTimes.push(performance.now() - start); }
const times = [];
for (let n = 0; n < 512; n++) {
  const start = performance.now();
  instance.writeInput('main', 0, input); instance.writeInput('main', 1, zero); instance.process();
  instance.readOutput('main', 0, outputs[0]); instance.readOutput('main', 1, outputs[1]);
  times.push(performance.now() - start);
}
assert.equal(instance.memory.buffer.byteLength, memoryBytes); assert.equal(instance.scrubbedSamples(), 0);
times.sort((a, b) => a - b);
const cost = { compileMs, coldQuantumMs, wasmBytes: compiled.wasm.byteLength, wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'), memoryBytes, blocks: 512, warmupBlocks: 128,
  maxProcessRssBytes: process.resourceUsage().maxRSS * 1024,
  startupMaxQuantumMs: Math.max(...startupTimes),
  includesInputOutputCopies: true, copyBytesPerQuantum: 2048, p50Ms: times[256], p99Ms: times[506], maxMs: times.at(-1),
  limitation: 'Single local Node instance of two modules, not browser realtime acceptance. Cold code execution and host jitter may exceed a quantum.' };

const reports = [];
for (const rate of [44100, 48000, 96000]) {
  const frames = 32768;
  const input = Float32Array.from({ length: frames }, (_, n) => n < frames - 256 ? 0.35 * Math.sin(n * 0.313) + 0.25 * Math.cos(n * 0.573) : 0);
  input[0] = 1; input[127] = -1; input[128] = 0.75;
  const reset = new Float32Array(frames); reset[511] = 1; reset.fill(1, 8191, 8196); reset[16384] = 1;
  const render = (start, end, restore) => renderOffline(processor, { sampleRate: rate, duration: (end - start - 0.25) / rate, inputs: { main: [input.slice(start, end), reset.slice(start, end)] }, restore });
  const result = await render(0, frames);
  const error = [0, 0]; let earliest = 0;
  for (let n = 0; n < frames; n++) {
    if (reset[n]) earliest = n + 1;
    const identity = n - 64 >= earliest ? input[n - 64] : 0;
    let convolution = 0;
    for (let k = 0; k < impulse.length; k++) if (n - 32 - k >= earliest) convolution += input[n - 32 - k] * impulse[k];
    error[0] = Math.max(error[0], Math.abs(identity - result.outputs.main[0][n]));
    error[1] = Math.max(error[1], Math.abs(convolution - result.outputs.main[1][n]));
  }
  assert(error[0] < 1.5e-7); assert(error[1] < 3e-7); assert.equal(result.diagnostics.scrubbedSamples, 0);
  const first = await render(0, 640), continued = await render(640, frames, first.state);
  result.outputs.main.forEach((channel, ch) => assert.deepEqual(continued.outputs.main[ch], channel.slice(640)));
  reports.push({ sampleRate: rate, frames, identityLatency: 64, convolutionLatency: 32, maxIdentityError: error[0], maxDirectFirError: error[1], snapshotBytes: first.state.byteLength, snapshotContinuation: 'bit-identical', scrubbedSamples: 0 });
}
cost.maxProcessRssBytes = process.resourceUsage().maxRSS * 1024;
writeFileSync('spectral-results.json', JSON.stringify({ status: 'CANDIDATE', reports, cost }, null, 2));
console.log(JSON.stringify({ reports, cost }));
