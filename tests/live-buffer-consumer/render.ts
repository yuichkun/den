import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compile, decodeScalar, decodeSnapshot } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import { capacity, makeMemoryProcessor, makeProcessor } from './processor.ts';
import { liveReference, type LiveRow } from './reference.ts';

const frames = 4096, reports = [];
const rows: LiveRow[] = Array.from({ length: frames }, (_, n) => ({ input: Math.fround(.65 * Math.sin(2 * Math.PI * n / 73) + .15 * Math.cos(n / 317)), record: !(n >= 1024 && n < 1408) && n % 19 > 3, reset: n >= 2045 && n < 2049, age: Math.fround((n % 263) + (n % 2 ? .25 : 0)) }));
const inputs = (data: readonly LiveRow[]) => ({ controls: [Float32Array.from(data, r => r.input), Float32Array.from(data, r => +r.record), Float32Array.from(data, r => +r.reset), Float32Array.from(data, r => r.age)] });
for (const sampleRate of [44100, 48000, 96000]) {
  const processor = makeProcessor(), expected = liveReference(capacity, rows).output;
  const run = (start: number, end: number, restore?: Uint8Array) => renderOffline(processor, { sampleRate, duration: (end - start - .25) / sampleRate, inputs: inputs(rows.slice(start, end)), ...(restore ? { restore } : {}) });
  const full = await run(0, frames);
  full.outputs.main.forEach((channel, ch) => assert.deepEqual(channel, expected[ch]));
  for (const split of [128, 1280, 2048, 2560]) {
    const first = await run(0, split), rest = await run(split, frames, first.state);
    rest.outputs.main.forEach((channel, ch) => assert.deepEqual(channel, full.outputs.main[ch].slice(split)));
    assert.equal(rest.diagnostics.scrubbedSamples, 0);
  }
  assert.equal(full.diagnostics.scrubbedSamples, 0);
  const slots = decodeSnapshot(full.state).slots;
  const bufferBytes = slots.filter(x => x.kind === 'buffer').reduce((total, x) => total + x.data.byteLength, 0);
  assert.equal(bufferBytes, 8 * (capacity + 1)); assert.equal(slots.some(x => x.name === 'history/readAge'), false);
  writeFileSync(`candidate-live-buffer-${sampleRate}.wav`, encodeWav([full.outputs.main[0], full.outputs.main[3]], sampleRate));
  const extremes = [0, -0, 2 ** -149, -(2 ** -149), 1e-35, -1e-35, 3.4028234663852886e38, -3.4028234663852886e38, NaN, Infinity, -Infinity];
  const extremeRows = Array.from({ length: 1024 }, (_, n) => ({ input: Math.fround(extremes[n % extremes.length]), record: n < 768, reset: n === 511, age: Math.fround(n < 768 ? n % 3 / 2 : n % 263) }));
  const extremeResult = await renderOffline(processor, { sampleRate, duration: (1024 - .25) / sampleRate, inputs: inputs(extremeRows) });
  extremeResult.outputs.main.forEach((channel, ch) => assert.deepEqual(channel, liveReference(capacity, extremeRows).output[ch]));
  assert.equal(extremeResult.diagnostics.scrubbedSamples, 0);
  reports.push({ sampleRate, frames, comparedChannels: 9, comparison: 'exact f32 equality for every output sample, including full-range input', snapshotSplits: [128, 1280, 2048, 2560], bufferBytes, stateBytes: full.state.byteLength, scrubbedSamples: full.diagnostics.scrubbedSamples });
}
const memoryProcessor = makeMemoryProcessor(), memoryFrames = 131200;
const recorded = await renderOffline(memoryProcessor, { sampleRate: 48000, duration: (memoryFrames - .25) / 48000 });
assert.deepEqual(recorded.outputs.main[0].slice(0, 65535), new Float32Array(65535));
assert.deepEqual(recorded.outputs.main[0].slice(65535), new Float32Array(memoryFrames - 65535).fill(.25));
const slots = decodeSnapshot(recorded.state).slots;
assert.equal(slots.find(x => x.name === 'history/pcm')!.data.byteLength, 8 * 65537);
assert.equal(decodeScalar('i32', slots.find(x => x.name === 'history/head')!.data), 128);
const compiled = await compile(memoryProcessor, { sampleRate: 48000 }), driver = await compiled.driver.instantiate(), memoryBytes = driver.memory.buffer.byteLength;
for (let n = 0; n < memoryFrames / 128; n++) driver.process();
assert.equal(driver.memory.buffer.byteLength, memoryBytes); assert.equal(driver.scrubbedSamples(), 0); assert.equal(recorded.diagnostics.scrubbedSamples, 0);
const diagnostic = { sampleRate: 48000, frames: memoryFrames, capacity: 65536, acceptedWrites: memoryFrames, wraps: 2, memoryBytes, wasmBytes: compiled.wasm.byteLength, wasmSHA256: createHash('sha256').update(compiled.wasm).digest('hex'), limitation: 'Active Node-driver bounded memory and offline PCM evidence; no browser/device/realtime guarantee' };
writeFileSync('live-buffer-results.json', JSON.stringify({ status: 'CANDIDATE', runtime: 'NOT_CLEARED', reports, diagnostic }, null, 2));
console.log(JSON.stringify({ reports, diagnostic }));
