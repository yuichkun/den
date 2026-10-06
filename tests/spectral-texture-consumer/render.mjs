import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compile } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import { makeProcessor } from './processor.ts';
import { directTextureWola, maxError } from './oracle.mjs';

const reports = [], costs = [];
for (const mode of ['blur', 'cross']) {
  const started = performance.now(), compiled = await compile(makeProcessor(mode), { sampleRate: 48000 });
  const compileMs = performance.now() - started, instance = await compiled.driver.instantiate(), memoryBytes = instance.memory.buffer.byteLength;
  const inputs = [Float32Array.from({ length: 128 }, (_, n) => 0.5 * Math.sin(n * .13)), Float32Array.from({ length: 128 }, (_, n) => 0.7 * Math.cos(n * .31)), new Float32Array(128).fill(1), new Float32Array(128)];
  const output = new Float32Array(128), startup = [], measured = [];
  for (let quantum = 0; quantum < 384; quantum++) {
    const begin = performance.now(); inputs.forEach((x, ch) => instance.writeInput('main', ch, x));
    instance.process(); instance.readOutput('main', 0, output);
    (quantum < 128 ? startup : measured).push(performance.now() - begin);
    assert(output.every(Number.isFinite));
  }
  assert(output.some(x => x !== 0)); assert.equal(instance.memory.buffer.byteLength, memoryBytes); assert.equal(instance.scrubbedSamples(), 0);
  measured.sort((a, b) => a - b);
  costs.push({ mode, size: 256, hopSize: 64, radius: mode === 'blur' ? 8 : null, maxGain: mode === 'cross' ? 16 : null, sampleRate: 48000,
    compileMs, coldQuantumMs: startup[0], startupMaximumMs: Math.max(...startup), p50Ms: measured[128], p99Ms: measured[253], maxMs: measured.at(-1),
    warmupQuanta: 128, measuredQuanta: 256, includesInputOutputCopies: true, copyBytesPerQuantum: 2560,
    memoryBytes, wasmBytes: compiled.wasm.byteLength, wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'),
    limitation: 'One loaded native driver, fixed memory; includes host jitter. No realtime, browser or concurrency clearance.' });
}

for (const rate of [44100, 48000, 96000]) for (const hop of [64, 128]) for (const mode of ['blur', 'cross']) {
  const size = 256, frames = 2304, p = makeProcessor(mode, size, hop);
  const input = [Float32Array.from({ length: frames }, (_, n) => n < 1537 ? 0.4 * Math.sin(2 * Math.PI * 9.375 * n / size) + (n % 137 === 0 ? 0.3 : 0) : 0),
    Float32Array.from({ length: frames }, (_, n) => n < 1537 ? 0.3 * Math.cos(2 * Math.PI * 17.125 * n / size) - (n % 191 === 0 ? 0.5 : 0) : 0),
    new Float32Array(frames).fill(.625), new Float32Array(frames)];
  input[3][255] = 1; input[3].fill(1, 1023, 1155); input[2].fill(1, 384, 897); input[2].fill(0, 1281, 1409);
  const render = (start, end, restore) => renderOffline(p, { sampleRate: rate, duration: (end - start - .25) / rate, inputs: { main: input.map(x => x.slice(start, end)) }, restore });
  const whole = await render(0, frames), error = maxError(whole.outputs.main[0], directTextureWola(input, size, hop, mode, mode === 'blur' ? 8 : 16));
  assert(error < 3e-7); assert.equal(whole.diagnostics.scrubbedSamples, 0);
  const splits = [128, 256, 896, 1024, 1152, 1280, 1664];
  for (const split of splits) {
    const first = await render(0, split), resumed = await render(split, frames, first.state);
    assert.deepEqual(resumed.outputs.main[0], whole.outputs.main[0].slice(split)); assert.deepEqual(resumed.state, whole.state); assert.equal(resumed.diagnostics.scrubbedSamples, 0);
  }
  const drainedTail = whole.outputs.main[0].slice(1537 + 2 * size);
  assert(drainedTail.length >= 128); assert(drainedTail.every(x => x === 0));
  const peak = Math.max(...whole.outputs.main[0].map(Math.abs)); assert(peak <= 32);
  reports.push({ mode, sampleRate: rate, size, hop, frames, independentDenseDftWolaError: error, peak, snapshotSplits: splits,
    continuation: 'bit-identical PCM and final native state', scrubbedSamples: 0, drained: true, checkedDrainedTailSamples: drainedTail.length });
}

// Explicit installed-package cross boundaries and modulator phase independence.
const boundaries = [];
for (const rate of [44100, 48000, 96000]) for (const [carrierLevel, modulatorLevel] of [[0, .5], [2 ** -130, .5], [.125, 1], [.5, 0], [.25, .25], [.25, -.25]]) {
  const input = [new Float32Array(1024).fill(carrierLevel), new Float32Array(1024).fill(modulatorLevel), new Float32Array(1024).fill(1), new Float32Array(1024)];
  const actual = await renderOffline(makeProcessor('cross', 64, 16), { sampleRate: rate, duration: (1024 - .25) / rate, inputs: { main: input } });
  const expected = Float32Array.from(directTextureWola(input, 64, 16, 'cross', 16)), error = maxError(actual.outputs.main[0], expected);
  assert(error <= Math.max(2 ** -149, Math.abs(carrierLevel) * 3e-7)); assert.equal(actual.diagnostics.scrubbedSamples, 0);
  if (carrierLevel === 0 || modulatorLevel === 0) assert(actual.outputs.main[0].every(x => x === 0));
  boundaries.push({ sampleRate: rate, carrierLevel, modulatorLevel, maxError: error });
}

const sampleRate = 48000, frames = 49152, sourceEnd = 48000, size = 64, hop = 16;
let seed = 611;
const carrier = Float32Array.from({ length: frames }, (_, n) => {
  if (n >= sourceEnd) return 0;
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return .32 * Math.sin(2 * Math.PI * 220 * n / sampleRate) + .16 * Math.cos(2 * Math.PI * 880 * n / sampleRate) + .08 * (seed / 2 ** 32 * 2 - 1);
});
const modulator = Float32Array.from({ length: frames }, (_, n) => n < sourceEnd ? (.28 * Math.cos(2 * Math.PI * 137 * n / sampleRate) + .12 * Math.cos(2 * Math.PI * 1900 * n / sampleRate)) * (.5 + .5 * Math.sin(2 * Math.PI * 7 * n / sampleRate)) : 0);
const amount = Float32Array.from({ length: frames }, (_, n) => n < 12000 ? 0 : n < 24000 ? .5 : 1), reset = new Float32Array(frames);
const outputs = [];
for (const mode of ['blur', 'cross']) {
  const result = await renderOffline(makeProcessor(mode, size, hop), { sampleRate, duration: (frames - .25) / sampleRate, inputs: { main: [carrier, modulator, amount, reset] } });
  assert.equal(result.diagnostics.scrubbedSamples, 0); assert(result.outputs.main[0].slice(sourceEnd + 2 * size).every(x => x === 0)); outputs.push(result.outputs.main[0]);
}
const aligned = Float32Array.from({ length: frames }, (_, n) => n >= size ? carrier[n - size] : 0);
const audioFile = 'candidate-spectral-texture-48000.wav', bytes = encodeWav([carrier, modulator, aligned, ...outputs], sampleRate);
writeFileSync(audioFile, bytes);
const audio = { file: audioFile, sha256: createHash('sha256').update(bytes).digest('hex'), status: 'CANDIDATE', humanApproved: false, sampleRate, frames,
  channels: ['original carrier', 'original modulator', 'N-aligned carrier', 'spectral blur', 'gain-bounded spectral cross-synthesis'],
  normalization: 'none', size, hopSize: hop, radius: 8, maxGain: 16, amountChanges: [[0, 0], [12000, .5], [24000, 1]], sourceEnd, drained: true,
  audibleLimitations: ['weak-bin phase replacement and possible floor jumps', 'frame smear/ringing and changed peaks', 'gain-capped magnitude transfer is not speech-envelope reconstruction'] };
const result = { status: 'CANDIDATE', reports, costs, boundaries, audio, maxProcessRssBytes: process.resourceUsage().maxRSS * 1024 };
writeFileSync('spectral-texture-results.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
