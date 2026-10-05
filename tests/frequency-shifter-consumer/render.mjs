import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { compile } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { processor, latencySamples } from './processor.ts';
import { ports, reference, maxError, complexBin, carrierBins, multitone } from './reference.mjs';

assert.equal(latencySamples, 31);
// Cold native process precedes all offline renders in this fresh process.
const start = performance.now(), compiled = await compile(processor, { sampleRate: 48000 });
const compileMs = performance.now() - start, instance = await compiled.driver.instantiate();
const memoryBytes = instance.memory.buffer.byteLength, controls = ports(48000, 128), output = new Float32Array(128);
const quantum = () => {
  const start = performance.now();
  controls.forEach((channel, i) => instance.writeInput('main', i, channel));
  instance.process(); instance.readOutput('main', 0, output);
  return performance.now() - start;
};
const coldQuantumMs = quantum(), startup = [coldQuantumMs];
for (let n = 0; n < 31; n++) startup.push(quantum());
const times = Array.from({ length: 256 }, quantum).sort((a, b) => a - b);
assert.equal(instance.memory.buffer.byteLength, memoryBytes); assert.equal(instance.scrubbedSamples(), 0);
const cost = { sampleRate: 48000, compileMs, coldQuantumMs, startupMaxMs: Math.max(...startup),
  wasmBytes: compiled.wasm.byteLength, wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'), memoryBytes,
  warmupBlocks: 32, measuredBlocks: 256, includesInputOutputCopies: true, copyBytesPerQuantum: 3072,
  p50Ms: times[128], p99Ms: times[253], maxMs: times.at(-1), budgetMs: 128 / 48,
  deadlineExceedances: times.filter(t => t > 128 / 48).length,
  limitation: 'Local Node instance only, with copies; cold execution and host jitter are measured, not a browser or realtime clearance.' };

const reports = [];
for (const rate of [44100, 48000, 96000]) {
  const frames = 4096;
  const channels = ports(rate, frames, {
    1: n => n < 512 ? rate / 73 : n < 768 ? 0 : n < 1536 ? -rate / 93 : n % 2 ? rate : -rate,
    2: n => n < 128 ? -1 : n < 256 ? 2 : (n % 89) / 88,
    3: n => n >= 700 && n < 1400 ? 1 : 0,
    4: n => n === 511 || n === 1537 || n >= 2047 && n <= 2052 ? 1 : 0,
  });
  const render = (input, restore) => renderOffline(processor, { sampleRate: rate, duration: (input[0].length - 0.25) / rate, inputs: { main: input }, restore });
  const result = await render(channels), error = maxError(result.outputs.main[0], reference(rate, channels));
  assert(error < 2e-7, `independent convolution mismatch: ${rate}, ${error}`);
  assert.equal(result.diagnostics.scrubbedSamples, 0);
  const split = 1152, first = await render(channels.map(a => a.slice(0, split)));
  const resumed = await render(channels.map(a => a.slice(split)), first.state);
  assert.deepEqual(resumed.outputs.main[0], result.outputs.main[0].slice(split));
  const sidebands = [];
  for (const sign of [-1, 1]) {
    const shifted = await render(ports(rate, 8192, { 0: multitone, 1: sign * rate / 32 }));
    assert.equal(shifted.diagnostics.scrubbedSamples, 0);
    const tail = shifted.outputs.main[0].slice(4096);
    for (const bin of carrierBins) {
      const desired = complexBin(tail, bin + sign * 128), image = complexBin(tail, bin - sign * 128);
      const phase = -2 * Math.PI * bin * 31 / 4096;
      const complexError = Math.hypot(desired.real - 0.15 * Math.cos(phase), desired.imaginary - 0.15 * Math.sin(phase));
      const rejectionDb = 20 * Math.log10(desired.magnitude / Math.max(image.magnitude, 1e-20));
      assert(complexError < 3e-5); assert(rejectionDb > 70);
      sidebands.push({ inputHz: bin * rate / 4096, shiftHz: sign * rate / 32, rejectionDb, complexError });
    }
  }
  reports.push({ sampleRate: rate, frames, latencySamples, maxReferenceError: error,
    snapshotBytes: first.state.byteLength, snapshotContinuation: 'bit-identical', scrubbedSamples: 0, sidebands });
}
cost.maxProcessRssBytes = process.resourceUsage().maxRSS * 1024;
writeFileSync('frequency-shifter-results.json', JSON.stringify({ status: 'CANDIDATE', reports, cost }, null, 2));
console.log(JSON.stringify({ reports, cost }));
