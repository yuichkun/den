import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compile, inspect } from '@unworklet/core';
import { renderOffline, encodeWav } from '@unworklet/offline';
import { makeProcessor, partials, voices, modes } from './processor.ts';
const f = Math.fround, frames = 8192, reports = [];
for (const rate of [44100, 48000, 96000]) {
  const processor = makeProcessor(), result = await renderOffline(processor, { sampleRate: rate, duration: (frames - 0.25) / rate });
  assert.equal(result.outputs.main[0].length, frames); assert.equal(result.diagnostics.scrubbedSamples, 0);
  const errors = Array(8).fill(0), weight = partials.reduce((sum, p) => sum + Math.abs(p.gain), 0), modeWeight = modes.reduce((sum, m) => sum + Math.abs(m.gain), 0);
  let fmPhase = 0;
  for (let n = 0; n < frames; n++) {
    const mod = f(Math.sin(2 * Math.PI * 110 * n / rate));
    const pm = Math.sin(2 * Math.PI * 440 * n / rate + 2 * mod), fm = Math.sin(2 * Math.PI * fmPhase);
    fmPhase += (440 + 220 * mod) / rate;
    const additive = partials.reduce((sum, p) => sum + p.gain / weight * Math.sin(2 * Math.PI * f(110 * p.ratio) * n / rate), 0);
    const unison = [0, 0];
    for (const v of voices) {
      const sine = Math.sin(2 * Math.PI * f(220 * 2 ** (v.detuneCents / 1200)) * n / rate);
      unison[0] += sine * (1 - v.pan) / 16; unison[1] += sine * (1 + v.pan) / 16;
    }
    const modal = modes.reduce((sum, m) => sum + m.gain / modeWeight * Math.exp(-Math.log(1000) * n / (m.decaySeconds * rate)) * Math.sin(2 * Math.PI * m.frequencyHz * (n + 1) / rate), 0);
    const comb = n >= 64 && n % 64 === 0 ? 0.5 ** (n / 64) : 0;
    const envelope = n < 32 ? (n + 1) / 32 : n < 64 ? 1 - 0.5 * (n - 31) / 32 : n < 1024 ? 0.5 : n < 1088 ? 0.5 * (1087 - n) / 64 : 0;
    [pm, fm, additive, ...unison, modal, comb, (unison[0] + unison[1]) * envelope].forEach((expected, ch) => {
      const actual = result.outputs.main[ch][n]; assert(Number.isFinite(actual)); errors[ch] = Math.max(errors[ch], Math.abs(actual - expected));
    });
  }
  errors.forEach((error, ch) => assert(error < (ch === 6 ? 3e-5 : 5e-6), `channel ${ch} rate ${rate} error ${error}`));
  const first = await renderOffline(processor, { sampleRate: rate, duration: (1024 - 0.25) / rate });
  const rest = await renderOffline(processor, { sampleRate: rate, duration: (1024 - 0.25) / rate, restore: first.state });
  result.outputs.main.forEach((ch, n) => assert.deepEqual(rest.outputs.main[n], ch.slice(1024, 2048)));
  const filename = `candidate-sources-${rate}.wav`;
  writeFileSync(filename, encodeWav(result.outputs.main.slice(3, 5), rate));
  writeFileSync(`candidate-resonators-${rate}.wav`, encodeWav(result.outputs.main.slice(5, 7), rate));
  reports.push({ rate, frames, filename, errors, scrubbedSamples: result.diagnostics.scrubbedSamples, stateBytes: result.state.byteLength, slots: Object.keys(inspect(result.state).slots).length });
}
// Bounded local diagnostic only: one maximum-capacity graph, no audio device.
const compiled = await compile(makeProcessor(), { sampleRate: 48000 }), instance = await compiled.driver.instantiate();
const memoryBytes = instance.memory.buffer.byteLength;
for (let i = 0; i < 8; i++) instance.process();
const timings = [];
for (let i = 0; i < 64; i++) { const t = performance.now(); instance.process(); timings.push(performance.now() - t); }
assert.equal(instance.memory.buffer.byteLength, memoryBytes); assert.equal(instance.scrubbedSamples(), 0);
timings.sort((a, b) => a - b);
const diagnostic = { graph: 'PM+FM+32 partials+8 unison+16 modes+20 Hz min comb+envelope', blocks: 64, warmupBlocks: 8, sampleRate: 48000,
  wasmBytes: compiled.wasm.byteLength, wasmSHA256: createHash('sha256').update(compiled.wasm).digest('hex'), memoryBytes,
  p50Ms: timings[32], p99Ms: timings[63], maxMs: timings.at(-1), budgetMs: 128 / 48, deadlineExceedances: timings.filter(x => x > 128 / 48).length,
  limitation: 'Local Node driver wall-clock; excludes browser scheduling and host copies; not a realtime guarantee.' };
writeFileSync('source-results.json', JSON.stringify({ status: 'CANDIDATE', reports, diagnostic }, null, 2));
console.log(JSON.stringify({ reports, diagnostic }));
