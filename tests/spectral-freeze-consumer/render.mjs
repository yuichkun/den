import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compile } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import { makeProcessor } from './processor.ts';
import { directFreezeWola, maxError } from './oracle.mjs';

const started = performance.now(), compiled = await compile(makeProcessor(), { sampleRate: 48000 });
const compileMs = performance.now() - started, instance = await compiled.driver.instantiate(), memoryBytes = instance.memory.buffer.byteLength;
const block = Float32Array.from({ length: 128 }, (_, n) => Math.sin(n * 0.13) * 0.5), zero = new Float32Array(128), freeze = new Float32Array(128), output = new Float32Array(128);
const write = () => { for (const [ch, values] of [block, zero, freeze].entries()) instance.writeInput('main', ch, values); };
write(); const coldStart = performance.now(); instance.process(); const coldQuantumMs = performance.now() - coldStart;
const startup = [coldQuantumMs], times = [];
for (let n = 0; n < 127; n++) { if (n === 16) freeze.fill(1); write(); const t = performance.now(); instance.process(); startup.push(performance.now() - t); }
for (let n = 0; n < 512; n++) {
  const t = performance.now(); write(); instance.process(); instance.readOutput('main', 0, output); times.push(performance.now() - t);
  assert(output.every(Number.isFinite));
}
assert.equal(instance.memory.buffer.byteLength, memoryBytes); assert.equal(instance.scrubbedSamples(), 0); times.sort((a, b) => a - b);
const cost = { sampleRate: 48000, size: 1024, frameHop: 512, executionDispatch: 128, compileMs, coldQuantumMs, startupMaxQuantumMs: Math.max(...startup),
  wasmBytes: compiled.wasm.byteLength, wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'), memoryBytes,
  warmupBlocks: 128, measuredBlocks: 512, copyBytesPerQuantum: 2048, p50Ms: times[256], p99Ms: times[506], maxMs: times.at(-1), includesInputOutputCopies: true,
  limitation: 'Fresh local Node driver; eager FFT every128 samples. Not browser/realtime/concurrency acceptance.' };
const reports = [];
for (const rate of [44100, 48000, 96000]) for (const hop of [256, 512]) {
  const size = 1024, frames = 12288, p = makeProcessor({ size, hopSize: hop });
  const inputs = [Float32Array.from({ length: frames }, (_, n) => n < 9216 ? 0.5 * Math.sin(2 * Math.PI * 13.375 * n / size) + 0.15 * Math.cos(2 * Math.PI * 71 * n / size) : 0),
    new Float32Array(frames), new Float32Array(frames)];
  inputs[2].fill(1, 2048, 7681); inputs[2].fill(1, 8703, 9729);
  inputs[1][1023] = 1; inputs[1][4225] = 1; inputs[1].fill(1, 6143, 6147);
  for (let t = 128; t < frames; t += 128) if (t % hop) inputs[2][t] = inputs[2][t] ? 0 : 1;
  const render = (start, end, restore) => renderOffline(p, { sampleRate: rate, duration: (end - start - 0.25) / rate, inputs: { main: inputs.map(x => x.slice(start, end)) }, restore });
  const whole = await render(0, frames), error = maxError(whole.outputs.main[0], directFreezeWola(...inputs, size, hop));
  const shiftError = maxError(whole.outputs.main[0], directFreezeWola(...inputs, size, hop, 'shift'));
  assert(error < 2e-7); assert(shiftError < 2e-7); assert.equal(whole.diagnostics.scrubbedSamples, 0);
  const snapshotSplits = [];
  for (const base of [2048, 4096, 6144, 8192]) for (let offset = 128; offset <= hop; offset += 128) {
    const split = base + offset, first = await render(0, split), resumed = await render(split, frames, first.state);
    assert.deepEqual(resumed.outputs.main[0], whole.outputs.main[0].slice(split)); assert.deepEqual(resumed.state, whole.state); assert.equal(resumed.diagnostics.scrubbedSamples, 0); snapshotSplits.push(split);
  }
  const peak = Math.max(...whole.outputs.main[0].map(Math.abs)); assert(peak < 64);
  assert(whole.outputs.main[0].slice(9729 + 2 * size).every(x => x === 0));
  reports.push({ sampleRate: rate, size, hop, frames, referenceAlignmentSamples: size, maxDftWolaError: error, maxCircularShiftWolaError: shiftError, peak,
    snapshotSplits, snapshotContinuation: 'bit-identical PCM and final state', scrubbedSamples: 0 });
}
// Quantify the deliberately nontransparent window imprint, including DC where
// minimum and maximum directly measure amplitude modulation rather than tone zeroes.
const textures = [];
for (const bin of [0, 13, 13.375]) {
  const size = 1024, frames = 8192, hold = new Float32Array(frames); hold.fill(1, 2048);
  const source = Float32Array.from({ length: frames }, (_, n) => 0.75 * Math.cos(2 * Math.PI * bin * n / size));
  const result = await renderOffline(makeProcessor({ size, hopSize: 256 }), { sampleRate: 48000, duration: (frames - 0.25) / 48000, inputs: { main: [source, new Float32Array(frames), hold] } });
  const steady = result.outputs.main[0].slice(4096), peak = Math.max(...steady.map(Math.abs));
  const periodError = maxError(steady.slice(size), steady.slice(0, -size));
  assert.equal(periodError, 0); assert.equal(result.diagnostics.scrubbedSamples, 0);
  if (bin === 0) { assert(Math.min(...steady) < 1e-7); assert(peak > 0.9); }
  textures.push({ inputBin: bin, inputPeak: 0.75, steadyPeak: peak, steadyMinimum: Math.min(...steady), exactPeriodSamples: size,
    periodicError: periodError, differenceFromDelayedLive: maxError(steady, source.slice(3072, 7168)),
    interpretation: bin === 0 ? 'DC demonstrates pronounced captured-window amplitude modulation' : 'Frozen N-periodic texture, not transparent pitch/envelope preservation' });
}
const auditionRate = 48000, auditionFrames = 98304, auditionSize = 1024;
const sourceEnd = 93184, releaseRequest = 93185;
let seed = 619;
const auditionInput = Float32Array.from({ length: auditionFrames }, (_, n) => {
  if (n >= sourceEnd) return 0;
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return 0.4 * Math.sin(2 * Math.PI * (n < 48000 ? 220 : 329.63) * n / auditionRate) + 0.1 * Math.sin(2 * Math.PI * 660 * n / auditionRate) + (seed / 2 ** 32 * 2 - 1) * 0.015;
});
const auditionHold = new Float32Array(auditionFrames); auditionHold.fill(1, 24001, 60001); auditionHold.fill(1, 72001, releaseRequest);
const audition = await renderOffline(makeProcessor(), { sampleRate: auditionRate, duration: (auditionFrames - 0.25) / auditionRate,
  inputs: { main: [auditionInput, new Float32Array(auditionFrames), auditionHold] } });
assert.equal(audition.diagnostics.scrubbedSamples, 0);
assert(audition.outputs.main[0].slice(releaseRequest + 2 * auditionSize).every(x => x === 0));
const aligned = Float32Array.from({ length: auditionFrames }, (_, n) => n >= auditionSize ? auditionInput[n - auditionSize] : 0);
const audioFile = 'candidate-spectral-freeze-48000.wav', audioBytes = encodeWav([auditionInput, aligned, audition.outputs.main[0]], auditionRate);
writeFileSync(audioFile, audioBytes);
const audio = { file: audioFile, sha256: createHash('sha256').update(audioBytes).digest('hex'), status: 'CANDIDATE', sampleRate: auditionRate,
  channels: ['original source', 'N-aligned reference', 'spectral freeze'], frames: auditionFrames, durationSeconds: auditionFrames / auditionRate,
  settings: { size: 1024, hopSize: 512, freezeIntervals: [[24001, 60001], [72001, releaseRequest]] }, normalization: 'none', sourceEnd, releaseRequest,
  zeroInputDrainSamples: auditionFrames - releaseRequest, completedTail: true,
  artifactsToAudition: ['pronounced periodic window imprint', 'off-bin alteration', 'capture/release smear', 'changed peaks'], humanApproved: false };
cost.maxProcessRssBytes = process.resourceUsage().maxRSS * 1024;
writeFileSync('spectral-freeze-results.json', JSON.stringify({ status: 'CANDIDATE', reports, cost, textures, audio }, null, 2));
console.log(JSON.stringify({ reports, cost, textures, audio }));
