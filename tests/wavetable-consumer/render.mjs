import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compile } from '@unworklet/core';
import { renderOffline, encodeWav } from '@unworklet/offline';
import { makeProcessor, pcm, frameLength, frameCount, seed } from './processor.ts';
import { tableReference, vaReference, noiseReference } from './wavetable-reference.ts';
const start = performance.now(), compiled = await compile(makeProcessor(), { sampleRate: 48000 }), compileMs = performance.now() - start;
const driver = await compiled.driver.instantiate(), memoryBytes = driver.memory.buffer.byteLength;
for (let n = 0; n < 32; n++) driver.process();
const timings = [];
for (let n = 0; n < 64; n++) { const t = performance.now(); driver.process(); timings.push(performance.now() - t); }
assert.equal(driver.memory.buffer.byteLength, memoryBytes); assert.equal(driver.scrubbedSamples(), 0);
assert(memoryBytes < 5 * 1024 * 1024); assert(compiled.wasm.byteLength < 100 * 1024);
timings.sort((a, b) => a - b);
const frames = 4096, reports = [], duration = (n, rate) => (n - .25) / rate;
for (const rate of [44100, 48000, 96000]) {
  const controls = [Float32Array.from({ length: frames }, (_, n) => n < 128 ? 0 : 440 + n % 11),
    Float32Array.from({ length: frames }, (_, n) => 15 * n / (frames - 1)),
    Float32Array.from({ length: frames }, (_, n) => .15 + .7 * (n % 257) / 256),
    Float32Array.from({ length: frames }, (_, n) => +(n >= 1023 && n <= 1026))];
  const p = makeProcessor(), full = await renderOffline(p, { sampleRate: rate, duration: duration(frames, rate), inputs: { controls }, messages: [{ name: 'load', payload: { data: pcm } }] });
  const waveControls = [controls[0], controls[1], controls[3]], vaControls = [controls[0], controls[2], controls[3]];
  const expected = [tableReference(pcm, rate, frameLength, frameCount, waveControls, .875), new Float32Array(frames), vaReference('pulse', rate, vaControls, .125), vaReference('triangle', rate, vaControls, .125), noiseReference(seed, controls[3])];
  const errors = expected.map((data, ch) => {
    let error = 0; assert.equal(full.outputs.main[ch].length, frames);
    data.forEach((x, n) => { const y = full.outputs.main[ch][n]; assert(Number.isFinite(y)); error = Math.max(error, Math.abs(x - y)); });
    assert(error < 2e-6, `rate=${rate} channel=${ch} maxError=${error}`); return error;
  });
  assert.equal(full.diagnostics.scrubbedSamples, 0);
  const first = await renderOffline(p, { sampleRate: rate, duration: duration(2048, rate), inputs: { controls: controls.map(x => x.slice(0, 2048)) }, messages: [{ name: 'load', payload: { data: pcm } }] });
  const rest = await renderOffline(p, { sampleRate: rate, duration: duration(2048, rate), inputs: { controls: controls.map(x => x.slice(2048)) }, restore: first.state });
  full.outputs.main.forEach((ch, i) => assert.deepEqual(rest.outputs.main[i], ch.slice(2048)));
  for (const [name, channel] of [['wavetable', 0], ['pulse', 2], ['triangle', 3], ['noise', 4]]) writeFileSync(`candidate-${name}-${rate}.wav`, encodeWav([full.outputs.main[channel]], rate));
  reports.push({ rate, frames, errors, stateBytes: full.state.byteLength, scrubbedSamples: full.diagnostics.scrubbedSamples });
}
const diagnostic = { graph: 'One maximum 65536-frame shared resident, 16x4096 table, pulse, triangle, seeded noise',
  compileMs, memoryBytes, wasmBytes: compiled.wasm.byteLength, wasmSHA256: createHash('sha256').update(compiled.wasm).digest('hex'),
  p50Ms: timings[32], maximumMs: timings.at(-1), warmupBlocks: 32, blocks: 64, residentLoaded: false,
  limitation: 'First graph compile in this Node process; imported compiler may be warm. Unloaded driver timing only, not active PCM ingress/browser/hardware realtime evidence.' };
writeFileSync('wavetable-results.json', JSON.stringify({ status: 'CANDIDATE', reports, diagnostic }, null, 2)); console.log(JSON.stringify({ reports, diagnostic }));
