import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compile } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import { makeProcessor } from './processor.ts';
import { directGateWola, maxError } from './oracle.mjs';

// Fresh-process first compile/process: includes the actual gate and eager128 dispatch.
const started = performance.now(), compiled = await compile(makeProcessor(), { sampleRate: 48000 });
const compileMs = performance.now() - started, instance = await compiled.driver.instantiate(), memoryBytes = instance.memory.buffer.byteLength;
const block = Float32Array.from({ length: 128 }, (_, n) => Math.sin(n * 0.13) * 0.5), zero = new Float32Array(128), threshold = new Float32Array(128).fill(0.2), floor = new Float32Array(128).fill(0.1), output = new Float32Array(128);
const write = () => { for (const [ch, values] of [block, zero, threshold, floor].entries()) instance.writeInput('main', ch, values); };
write(); const coldStart = performance.now(); instance.process(); const coldQuantumMs = performance.now() - coldStart;
const startup = [coldQuantumMs], times = [];
for (let n = 0; n < 127; n++) { const t = performance.now(); instance.process(); startup.push(performance.now() - t); }
for (let n = 0; n < 512; n++) {
  const t = performance.now(); write(); instance.process(); instance.readOutput('main', 0, output); times.push(performance.now() - t);
  assert(output.every(Number.isFinite));
}
assert.equal(instance.memory.buffer.byteLength, memoryBytes); assert.equal(instance.scrubbedSamples(), 0); times.sort((a, b) => a - b);
const cost = { sampleRate: 48000, size: 1024, frameHop: 512, executionDispatch: 128, compileMs, coldQuantumMs, startupMaxQuantumMs: Math.max(...startup),
  wasmBytes: compiled.wasm.byteLength, wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'), memoryBytes,
  warmupBlocks: 128, measuredBlocks: 512, copyBytesPerQuantum: 2560, p50Ms: times[256], p99Ms: times[506], maxMs: times.at(-1), includesInputOutputCopies: true,
  limitation: 'Fresh local Node driver; eager FFT every128 samples. Not browser/realtime/concurrency acceptance.' };
const reports = [];
for (const rate of [44100, 48000, 96000]) for (const hop of [256, 512]) {
  const size = 1024, frames = 8192, p = makeProcessor({ size, hopSize: hop });
  const inputs = [Float32Array.from({ length: frames }, (_, n) => n < frames - size ? 0.5 * Math.sin(2 * Math.PI * 13.375 * n / size) + 0.15 * Math.cos(2 * Math.PI * 71 * n / size) : 0),
    new Float32Array(frames), new Float32Array(frames).fill(0.2), new Float32Array(frames).fill(0.1)];
  inputs[0][257] = 1; inputs[1][1023] = 1; inputs[1].fill(1, 4095, 4099);
  for (const n of [127, 128, 129, 255, 256, 257, 511, 512, 513, 2047, 2048, 2049, 5120, 5248]) {
    inputs[2].fill(n % 2 ? 0.5 : 0.025, n); inputs[3].fill(n % 3 ? 0.05 : 0.5, n);
  }
  const render = (start, end, restore) => renderOffline(p, { sampleRate: rate, duration: (end - start - 0.25) / rate, inputs: { main: inputs.map(x => x.slice(start, end)) }, restore });
  const whole = await render(0, frames), expected = directGateWola(...inputs, size, hop), error = maxError(whole.outputs.main[0], expected);
  assert(error < 2e-7); assert.equal(whole.diagnostics.scrubbedSamples, 0);
  for (const offset of [128, 256, 384, 512]) {
    const split = 4096 + offset, first = await render(0, split), resumed = await render(split, frames, first.state);
    assert.deepEqual(resumed.outputs.main[0], whole.outputs.main[0].slice(split)); assert.deepEqual(resumed.state, whole.state); assert.equal(resumed.diagnostics.scrubbedSamples, 0);
  }
  const peak = Math.max(...whole.outputs.main[0].map(Math.abs)); assert(peak < 64);
  reports.push({ sampleRate: rate, size, hop, frames, referenceAlignmentSamples: size, maxDftWolaError: error, peak,
    snapshotPhaseOffsets: [128, 256, 384, 512], snapshotContinuation: 'bit-identical PCM and final state', scrubbedSamples: 0 });
}
// One original musical/noise texture, explicitly CANDIDATE. Three channels:
// source, N-aligned reference, gate. No per-channel gain normalization.
const auditionRate = 48000, auditionFrames = 50176, auditionSize = 1024;
let seed = 613;
const auditionInput = Float32Array.from({ length: auditionFrames }, (_, n) => {
  if (n >= auditionFrames - 2 * auditionSize) return 0;
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const noise = (seed / 2 ** 32 * 2 - 1) * 0.035;
  const burst = n % 12000 < 6000 ? 1 : 0;
  return burst * (0.45 * Math.sin(2 * Math.PI * 440 * n / auditionRate) + 0.08 * Math.sin(2 * Math.PI * 1320 * n / auditionRate)) + noise;
});
const audition = await renderOffline(makeProcessor(), { sampleRate: auditionRate, duration: (auditionFrames - 0.25) / auditionRate,
  inputs: { main: [auditionInput, new Float32Array(auditionFrames), new Float32Array(auditionFrames).fill(0.08), new Float32Array(auditionFrames).fill(0.08)] } });
assert.equal(audition.diagnostics.scrubbedSamples, 0);
// The original source is unchanged; an additional N zeros completes the2N drain.
assert(audition.outputs.main[0].slice(-auditionSize / 2).every(x => x === 0));
const aligned = Float32Array.from({ length: auditionFrames }, (_, n) => n >= auditionSize ? auditionInput[n - auditionSize] : 0);
const audioFile = 'candidate-spectral-gate-48000.wav';
writeFileSync(audioFile, encodeWav([auditionInput, aligned, audition.outputs.main[0]], auditionRate));
const audio = { file: audioFile, sha256: createHash('sha256').update(encodeWav([auditionInput, aligned, audition.outputs.main[0]], auditionRate)).digest('hex'),
  status: 'CANDIDATE', sampleRate: auditionRate, channels: ['original source', 'N-aligned reference', 'spectral gate'], frames: auditionFrames,
  durationSeconds: auditionFrames / auditionRate, sourceFrames: auditionFrames - 2 * auditionSize,
  settings: { size: 1024, hopSize: 512, threshold: 0.08, floor: 0.08 }, normalization: 'none',
  zeroInputDrainSamples: 2 * auditionSize, zeroInputDrainSeconds: 2 * auditionSize / auditionRate, completedTail: true,
  artifactsToAudition: ['musical noise', 'transient ringing/smear', 'threshold pumping', 'changed peaks'], humanApproved: false };
cost.maxProcessRssBytes = process.resourceUsage().maxRSS * 1024;
writeFileSync('spectral-gate-results.json', JSON.stringify({ status: 'CANDIDATE', reports, cost, audio }, null, 2));
console.log(JSON.stringify({ reports, cost, audio }));
