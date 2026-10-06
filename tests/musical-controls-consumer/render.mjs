import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compile, inspect } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { makeEnvelopeProcessor } from './processor.ts';
import { makeLfoProcessor, waveforms } from './lfo-processor.ts';
import { channels, envelopeRows, envelopeReference, lfoRows, lfoReference, waveReference, minimum, phaseMaximum } from './reference.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const reports = [], costs = [], evidence = [];
function save(kind, rate, result) {
  const pcm = Buffer.concat(result.outputs.main.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  const file = `candidate-${kind}-${rate}.f32`, stateFile = `candidate-${kind}-${rate}-state.bin`;
  writeFileSync(file, pcm); writeFileSync(stateFile, result.state);
  evidence.push({ file, sha256: sha(pcm), stateFile, stateSha256: sha(result.state), channels: result.outputs.main.length,
    frames: result.outputs.main[0].length, layout: 'channel-major little-endian f32 controls; not an audio audition', status: 'CANDIDATE' });
}
async function checkSnapshots(processor, rate, input, whole, splits) {
  const frames = input[0].length;
  const render = (start, end, restore) => renderOffline(processor, { sampleRate: rate, duration: (end - start - .25) / rate,
    inputs: { controls: input.map(c => c.slice(start, end)) }, restore });
  for (const split of splits) {
    const first = await render(0, split), resumed = await render(split, frames, first.state);
    whole.outputs.main.forEach((channel, n) => assert.deepEqual(resumed.outputs.main[n], channel.slice(split)));
    assert.deepEqual(resumed.state, whole.state); assert.equal(resumed.diagnostics.scrubbedSamples, 0);
  }
}
for (const sampleRate of [44100, 48000, 96000]) {
  const rows = envelopeRows(sampleRate), input = channels(rows), processor = makeEnvelopeProcessor();
  const result = await renderOffline(processor, { sampleRate, duration: (rows.length - .25) / sampleRate, inputs: { controls: input } });
  const expected = envelopeReference(rows, sampleRate); let maximumError = 0;
  expected.forEach(([level, done], n) => {
    maximumError = Math.max(maximumError, Math.abs(result.outputs.main[0][n] - level));
    assert.equal(result.outputs.main[1][n], done, `ADSR done frame ${n}`);
  });
  assert(maximumError < 8e-8); assert.equal(result.outputs.main[0][0], minimum);
  assert.equal(result.outputs.main[0][18], 0); assert.equal(result.outputs.main[1][18], 0); assert.equal(result.outputs.main[1][23], 1);
  assert.equal(result.diagnostics.scrubbedSamples, 0);
  const splits = [128, 256, 512]; await checkSnapshots(processor, sampleRate, input, result, splits);
  reports.push({ kind: 'curvedAdsr', sampleRate, frames: rows.length, maximumError, exactDone: true,
    snapshotSplits: splits, continuation: 'bit-identical f32 controls and final native state, including mid-attack and mid-release',
    stateSlots: Object.keys(inspect(result.state).slots).length, scrubbedSamples: 0 });
  save('curved-adsr', sampleRate, result);
  for (const [mode, beats] of [['free', 1], ['tempo', 1 / 4], ['tempo', 1 / 64], ['tempo', 64]]) {
    const schedule = lfoRows(), inputs = channels(schedule), p = makeLfoProcessor(mode, beats);
    const rendered = await renderOffline(p, { sampleRate, duration: (schedule.length - .25) / sampleRate, inputs: { controls: inputs } });
    const phase = lfoReference(schedule, sampleRate, mode, beats); let maximumWaveError = 0;
    phase.forEach((value, n) => waveforms.forEach((wave, w) => {
      assert.equal(rendered.outputs.main[w * 2 + 1][n], value, `${mode}/${beats} phase at ${n}`);
      maximumWaveError = Math.max(maximumWaveError, Math.abs(rendered.outputs.main[w * 2][n] - waveReference(wave, value)));
    }));
    assert(maximumWaveError < 8e-8); assert.equal(rendered.outputs.main[1][1280], phaseMaximum);
    assert.equal(rendered.outputs.main[1][1792], minimum); // Large integer offset preserves a tiny sought base phase.
    assert.equal(rendered.diagnostics.scrubbedSamples, 0);
    const splits = [128, 896, 1280]; await checkSnapshots(p, sampleRate, inputs, rendered, splits);
    reports.push({ kind: 'musicalLfo', sampleRate, mode, beatsPerCycle: beats, waveforms, frames: schedule.length,
      maximumWaveError, exactPublicPhase: true, snapshotSplits: splits, continuation: 'bit-identical f32 controls and final native state',
      stateSlots: Object.keys(inspect(rendered.state).slots).length, scrubbedSamples: 0 });
    save(`lfo-${mode}-${beats}`, sampleRate, rendered);
  }
}

for (const kind of ['curvedAdsr', 'musicalLfo']) {
  const sampleRate = 48000, start = performance.now();
  const compiled = await compile(kind === 'curvedAdsr' ? makeEnvelopeProcessor() : makeLfoProcessor(), { sampleRate });
  const compileMs = performance.now() - start, beginInstantiation = performance.now(), instance = await compiled.driver.instantiate();
  const instantiateMs = performance.now() - beginInstantiation, memoryBytes = instance.memory.buffer.byteLength;
  const rows = kind === 'curvedAdsr'
    ? Array.from({ length: 128 }, (_, n) => [Number(n < 80), Number(n === 31), Number(n === 127), 16 / sampleRate, 32 / sampleRate, .25, 24 / sampleRate, -1, 1, -.5])
    : Array.from({ length: 128 }, (_, n) => [137, 0, Number(n === 0), .125, n / 128, Number(n >= 40 && n < 60)]);
  const inputs = channels(rows), outputChannels = kind === 'curvedAdsr' ? 2 : 8, output = Array.from({ length: outputChannels }, () => new Float32Array(128));
  const startup = [], measured = []; let hasNonzero = false;
  for (let quantum = 0; quantum < 384; quantum++) {
    const begin = performance.now(); inputs.forEach((input, ch) => instance.writeInput('controls', ch, input));
    instance.process(); output.forEach((buffer, ch) => instance.readOutput('main', ch, buffer));
    (quantum < 128 ? startup : measured).push(performance.now() - begin);
    output.forEach(c => assert(c.every(Number.isFinite))); hasNonzero ||= output[0].some(x => x !== 0);
  }
  assert(hasNonzero); assert.equal(instance.memory.buffer.byteLength, memoryBytes); assert.equal(instance.scrubbedSamples(), 0);
  measured.sort((a, b) => a - b);
  costs.push({ kind, sampleRate, compileMs, instantiateMs, coldQuantumMs: startup[0], startupMaximumMs: Math.max(...startup),
    warmupQuanta: 128, measuredQuanta: 256, p50Ms: measured[128], p99Ms: measured[253], maxMs: measured.at(-1),
    includesInputOutputCopies: true, copyBytesPerQuantum: (inputs.length + outputChannels) * 128 * 4,
    memoryBytes, memoryGrowthBytes: 0, wasmBytes: compiled.wasm.byteLength, wasmSha256: sha(compiled.wasm), scrubbedSamples: 0,
    limitation: 'One local native driver with changing controls, including copies and host jitter; no browser, realtime, concurrency or listening clearance.' });
}
const report = { status: 'CANDIDATE', runtime: 'NOT_CLEARED', reports, costs, evidence, maxProcessRssBytes: process.resourceUsage().maxRSS * 1024,
  limits: ['Control signals only, not approved sounds', 'Public f32 LFO phase is quantized', 'Waveforms are non-bandlimited', 'No 30-second maximum-duration stress render', 'Native snapshots require identical configuration'] };
writeFileSync('musical-controls-results.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
