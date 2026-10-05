import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compile } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import { makeProcessor, pcm, sourceRate } from './processor.ts';
import { loopReference } from './reference.ts';
const frames = 4096, reports = [];
for (const sampleRate of [44100, 48000, 96000]) {
  const processor = makeProcessor(), options = { start: 3, end: 997, crossfade: 127, release: 31 };
  const rows = Array.from({ length: frames }, (_, n) => ({ gate: n < 3500, reset: n >= 2040 && n < 2043, trigger: n === 2500, rate: n < 1536 ? .75 : -.625 }));
  const a = loopReference(pcm, sampleRate, sourceRate, rows, options), b = loopReference(pcm, sampleRate, sourceRate, rows.map(x => ({ ...x, rate: -1.25 })), options);
  const expected = [a[0], b[0], a[3], a[2], a[4], a[5], a[1], a[6]];
  const result = await renderOffline(processor, { sampleRate, duration: (frames - .25) / sampleRate, messages: [{ name: 'load', payload: { data: pcm } }] });
  const errors = expected.map((values, ch) => {
    let maximum = 0; assert.equal(result.outputs.main[ch].length, frames);
    result.outputs.main[ch].forEach((value, n) => { assert(Number.isFinite(value)); maximum = Math.max(maximum, Math.abs(value - values[n])); });
    assert(maximum < 4e-6, `rate=${sampleRate} ch=${ch} max=${maximum}`); return maximum;
  });
  assert.equal(result.diagnostics.scrubbedSamples, 0);
  const split = 1152, first = await renderOffline(processor, { sampleRate, duration: (split - .25) / sampleRate, messages: [{ name: 'load', payload: { data: pcm } }] });
  const rest = await renderOffline(processor, { sampleRate, duration: (frames - split - .25) / sampleRate, restore: first.state });
  result.outputs.main.forEach((values, ch) => assert.deepEqual(rest.outputs.main[ch], values.slice(split)));
  writeFileSync(`candidate-loop-crossfade-${sampleRate}.wav`, encodeWav(result.outputs.main.slice(0, 2), sampleRate));
  reports.push({ sampleRate, frames, errors, stateBytes: result.state.byteLength, snapshotSplit: split, scrubbedSamples: result.diagnostics.scrubbedSamples });
}
const compiled = await compile(makeProcessor(), { sampleRate: 48000 }), driver = await compiled.driver.instantiate(), memoryBytes = driver.memory.buffer.byteLength;
for (let n = 0; n < 64; n++) driver.process();
assert.equal(driver.memory.buffer.byteLength, memoryBytes); assert.equal(driver.scrubbedSamples(), 0);
const diagnostic = { sampleRate: 48000, residentLoaded: false, blocks: 64, memoryBytes, wasmBytes: compiled.wasm.byteLength, wasmSHA256: createHash('sha256').update(compiled.wasm).digest('hex'), limitation: 'Unloaded Node driver fixed-memory diagnostic only; no browser/device/realtime deadline evidence' };
writeFileSync('loop-crossfade-results.json', JSON.stringify({ status: 'CANDIDATE', reports, diagnostic }, null, 2)); console.log(JSON.stringify({ reports, diagnostic }));
