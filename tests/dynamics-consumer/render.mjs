import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { compile, inspect } from '@unworklet/core';
import { renderOffline, encodeWav } from '@unworklet/offline';
import { makeProcessor } from './processor.ts';
const reports = [], performanceReports = [];
const f = Math.fround;
function curve(level, expand) {
  const d = level + 12;
  const output = expand
    ? d >= 3 ? level : d <= -3 ? -12 + 4 * d : level - 3 * (d - 3) ** 2 / 12
    : d <= -3 ? level : d >= 3 ? -12 + d / 4 : level - 0.75 * (d + 3) ** 2 / 12;
  return Math.min(36, Math.max(0, level - output));
}
for (const rate of [44100, 48000, 96000]) for (const operation of ['compressor', 'expander', 'gate', 'duck']) {
  const frames = 32768;
  const input = [Float32Array.from({ length: frames }, (_, n) => 0.5 * Math.sin(2 * Math.PI * 110 * n / rate)),
    Float32Array.from({ length: frames }, (_, n) => -0.25 * Math.sin(2 * Math.PI * 110 * n / rate)),
    Float32Array.from({ length: frames }, (_, n) => n >= 2048 && n < 16384 ? 0.8 : 0), new Float32Array(frames)];
  const processor = makeProcessor(operation), start = performance.now();
  const result = await renderOffline(processor, { sampleRate: rate, duration: (frames - 0.25) / rate, inputs: { main: input } });
  assert.equal(result.outputs.main[0].length, frames); assert.equal(result.diagnostics.scrubbedSamples, 0);
  let power = 0, attenuation = 0, active = false, maxAudioError = 0, maxGainDbError = 0, maxEnvelopeError = 0;
  for (let n = 0; n < frames; n++) {
    const targetPower = input[2][n] ** 2;
    power += (targetPower - power) * -Math.expm1(-1 / (rate * f(targetPower > power ? 0.001 : 0.01)));
    const envelope = Math.sqrt(power), level = 20 * Math.log10(Math.max(1e-30, envelope));
    active = level >= -12 || active && level > -15;
    const target = operation === 'compressor' ? curve(level, false) : operation === 'expander' ? curve(level, true) : (operation === 'duck' ? active : !active) ? 36 : 0;
    const opens = operation === 'gate' || operation === 'expander';
    const seconds = target > attenuation ? (opens ? 0.07 : 0.003) : (opens ? 0.003 : 0.07);
    attenuation += (target - attenuation) * -Math.expm1(-1 / (rate * f(seconds)));
    const gain = 10 ** (-attenuation / 20);
    for (let ch = 0; ch < 2; ch++) maxAudioError = Math.max(maxAudioError, Math.abs(result.outputs.main[ch][n] - input[ch][n] * gain));
    maxEnvelopeError = Math.max(maxEnvelopeError, Math.abs(result.outputs.main[2][n] - envelope));
    maxGainDbError = Math.max(maxGainDbError, Math.abs(result.outputs.main[3][n] + attenuation));
    assert.equal(result.outputs.main[0][n], -2 * result.outputs.main[1][n]);
  }
  assert(maxAudioError < 5e-6); assert(maxGainDbError < 0.0001); assert(maxEnvelopeError < 2e-6);
  const first = await renderOffline(processor, { sampleRate: rate, duration: (8192 - 0.25) / rate, inputs: { main: input.map(c => c.slice(0, 8192)) } });
  const resumed = await renderOffline(processor, { sampleRate: rate, duration: (frames - 8192 - 0.25) / rate, inputs: { main: input.map(c => c.slice(8192)) }, restore: first.state });
  result.outputs.main.forEach((ch, i) => assert.deepEqual(resumed.outputs.main[i], ch.slice(8192)));
  const filename = `candidate-${operation}-${rate}.wav`;
  writeFileSync(filename, encodeWav(result.outputs.main.slice(0, 2), rate));
  reports.push({ rate, operation, frames, filename, maxAudioError, maxGainDbError, maxEnvelopeError, scrubbedSamples: result.diagnostics.scrubbedSamples,
    stateBytes: result.state.byteLength, slots: Object.keys(inspect(result.state).slots).length, verificationElapsedMs: performance.now() - start });
  if (rate !== 48000) continue;
  const compiled = await compile(processor, { sampleRate: rate }), instance = await compiled.driver.instantiate();
  const settings = { threshold: -12, ratio: 4, knee: 6, range: 36, attack: 0.003, release: 0.07, detectorAttack: 0.001, detectorRelease: 0.01 };
  for (const [key, value] of Object.entries(settings)) instance.writeParam(key, new Float32Array(128).fill(value));
  for (let ch = 0; ch < 4; ch++) instance.writeInput('main', ch, new Float32Array(128).fill(ch < 2 ? 0.2 : 0.8));
  const beforeMemory = instance.memory.buffer.byteLength;
  for (let n = 0; n < 256; n++) instance.process();
  const samples = [], blocks = 2048;
  for (let n = 0; n < blocks; n++) { const t = performance.now(); instance.process(); samples.push(performance.now() - t); }
  assert.equal(instance.memory.buffer.byteLength, beforeMemory); assert.equal(instance.scrubbedSamples(), 0);
  samples.sort((a, b) => a - b);
  performanceReports.push({ operation, sampleRate: rate, framesPerBlock: 128, warmup: 256, blocks, settings, node: process.version,
    wasmBytes: compiled.wasm.byteLength, wasmSHA256: createHash('sha256').update(compiled.wasm).digest('hex'), memoryBytes: beforeMemory,
    p50Ms: samples[1024], p99Ms: samples[Math.floor(blocks * 0.99)], maxMs: samples.at(-1), budgetMs: 128 / 48,
    deadlineExceedances: samples.filter(x => x > 128 / 48).length,
    limitation: 'Local Node driver wall-clock diagnostic; fixed controls/DC inputs, excludes input/output copies and browser scheduling; not real-time acceptance.' });
}
writeFileSync('dynamics-results.json', JSON.stringify({ status: 'CANDIDATE', reports, performanceReports }, null, 2));
console.log(JSON.stringify({ reports, performanceReports }));
