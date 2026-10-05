import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compile } from '@unworklet/core';
import { renderOffline, encodeWav } from '@unworklet/offline';
import { prepareWavetableBands } from '@denaudio/den/wavetable';
import { makeProcessor, prepared, frames, frameLength, frameCount } from './processor.ts';
import { bandsReference, coefficient } from './wavetable-bands-reference.ts';
const start = performance.now(), compiled = await compile(makeProcessor(), { sampleRate: 48000 }), compileMs = performance.now() - start;
const driver = await compiled.driver.instantiate(), memoryBytes = driver.memory.buffer.byteLength;
for (let n = 0; n < 32; n++) driver.process();
const timings = [];
for (let n = 0; n < 64; n++) { const t = performance.now(); driver.process(); timings.push(performance.now() - t); }
assert.equal(driver.memory.buffer.byteLength, memoryBytes); assert.equal(driver.scrubbedSamples(), 0);
assert(memoryBytes < 5 * 1024 * 1024); assert(compiled.wasm.byteLength < 150 * 1024); timings.sort((a, b) => a - b);
const n = 4096, reports = [], duration = (n, rate) => (n - .25) / rate;
const edited = prepareWavetableBands({ frames: frames.map(x => Float32Array.from(x, v => -.5 * v)) });
for (const rate of [44100, 48000, 96000]) {
  const boundaries = prepared.harmonicLimits.flatMap(h => [.225 * rate / h, .45 * rate / h]);
  const controls = [Float32Array.from({ length: n }, (_, i) => i < 128 ? 0 : i < 512 ? boundaries[i % boundaries.length] : rate * .45 * (i - 512) / (n - 512)),
    Float32Array.from({ length: n }, (_, i) => (frameCount - 1) * i / (n - 1)),
    Float32Array.from({ length: n }, (_, i) => +(i >= 1023 && i <= 1026))];
  const p = makeProcessor(), full = await renderOffline(p, { sampleRate: rate, duration: duration(n, rate), inputs: { controls }, messages: [{ name: 'load', payload: { data: prepared.data } }] });
  const expected = bandsReference(prepared.data, rate, frameLength, frameCount, controls, .975);
  let error = 0; full.outputs.main[0].forEach((v, i) => { assert(Number.isFinite(v)); error = Math.max(error, Math.abs(v - expected[i])); });
  assert(error < 2e-6, `rate=${rate}, error=${error}`); assert.deepEqual(full.outputs.main[1], new Float32Array(n)); assert.equal(full.diagnostics.scrubbedSamples, 0);
  const first = await renderOffline(p, { sampleRate: rate, duration: duration(2048, rate), inputs: { controls: controls.map(x => x.slice(0, 2048)) }, messages: [{ name: 'load', payload: { data: prepared.data } }] });
  const rest = await renderOffline(p, { sampleRate: rate, duration: duration(2048, rate), inputs: { controls: controls.map(x => x.slice(2048)) }, restore: first.state });
  full.outputs.main.forEach((ch, i) => assert.deepEqual(rest.outputs.main[i], ch.slice(2048)));
  const replaceControls = [new Float32Array(512).fill(317), new Float32Array(512).fill(8.5), new Float32Array(512)];
  const replacement = await renderOffline(p, { sampleRate: rate, duration: duration(512, rate), inputs: { controls: replaceControls }, messages: [
    { name: 'load', payload: { data: prepared.data } }, { name: 'load', payload: { data: edited.data }, atQuantum: 1 },
    { name: 'load', payload: { data: edited.data.slice(0, -1) }, atQuantum: 2 }, { name: 'load', payload: { data: edited.data }, atQuantum: 3 },
  ] });
  assert.deepEqual(replacement.outputs.main[0].slice(256, 384), new Float32Array(128));
  assert.deepEqual(replacement.outputs.main[0].slice(128, 256), replacement.outputs.main[0].slice(384));
  const replacementExpected = bandsReference(edited.data, rate, frameLength, frameCount, replaceControls.map(x => x.slice(0, 128)), .975);
  replacementExpected.forEach((x, i) => assert(Math.abs(x - replacement.outputs.main[0][128 + i]) < 2e-6));
  // Independent Fourier coefficients verify every prepared band against original
  // analytic data. This does not reuse the host FFT or native selection graph.
  let spectralError = 0;
  prepared.harmonicLimits.forEach((h, b) => {
    const cycle = prepared.data.slice(b * frameLength * frameCount, b * frameLength * frameCount + frameLength);
    for (const k of [0, 1, 3, 11, 101, 255, 256]) {
      const observed = coefficient(cycle, k), desired = k <= h ? coefficient(frames[0], k) : { re: 0, im: 0 };
      spectralError = Math.max(spectralError, Math.abs(observed.re - desired.re), Math.abs(observed.im - desired.im));
    }
  });
  assert(spectralError < 1e-7); assert.equal(replacement.diagnostics.scrubbedSamples, 0);
  writeFileSync(`candidate-banded-wavetable-${rate}.wav`, encodeWav([full.outputs.main[0]], rate));
  reports.push({ rate, frames: n, error, spectralError, stateBytes: full.state.byteLength, scrubbedSamples: full.diagnostics.scrubbedSamples });
}
const diagnostic = { graph: 'One 65536-sample resident, 512x16x8 bands, four local cycle interpolations, eight integer resident reads/16 PCM taps', compileMs, memoryBytes, wasmBytes: compiled.wasm.byteLength, wasmSHA256: createHash('sha256').update(compiled.wasm).digest('hex'), p50Ms: timings[32], maximumMs: timings.at(-1), warmupBlocks: 32, blocks: 64, residentLoaded: false, limitation: 'Unloaded compile-driver timing only; loaded ingress/render correctness is tested separately. No browser/hardware realtime claim.' };
writeFileSync('wavetable-bands-results.json', JSON.stringify({ status: 'CANDIDATE', reports, diagnostic }, null, 2)); console.log(JSON.stringify({ reports, diagnostic }));
