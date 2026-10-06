import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compile, decodeScalar, decodeSnapshot } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import { capacity, maxGrains, makeMemoryProcessor, makeProcessor } from './processor.ts';
import { liveGrainError, liveGrainPorts, liveGrainReference, liveGrainRows } from './reference.ts';
const reports = [], frames = 4096;
for (const sampleRate of [44100, 48000, 96000]) {
  const rows = liveGrainRows(frames, n => ({ input: .6 * Math.sin(n * .107) + .2 * Math.cos(n / 317), record: !(n >= 1024 && n < 1408) && n % 7 > 1, reset: n >= 2045 && n < 2049, trigger: n % 3 === 0, age: [0, .25, 32, 128, 255.75, 256, 257][n % 7], rate: [-2, -.5, 0, .5, 1, 2][n % 6], seconds: 127 / sampleRate }));
  const processor = makeProcessor(), expected = liveGrainReference(capacity, maxGrains, sampleRate, rows);
  const run = (start: number, end: number, restore?: Uint8Array) => renderOffline(processor, { sampleRate, duration: (end - start - .25) / sampleRate, inputs: { controls: liveGrainPorts(rows.slice(start, end)) }, restore });
  const full = await run(0, frames);
  const maxError = liveGrainError(full.outputs.main[0], expected[0]); assert(maxError <= 2e-7);
  full.outputs.main.slice(1).forEach((ch, n) => assert.deepEqual(ch, expected[n + 1]));
  for (const split of [128, 1280, 2048, 2560]) {
    const first = await run(0, split), rest = await run(split, frames, first.state);
    assert.deepEqual(rest.outputs.main, full.outputs.main.map(c => c.slice(split))); assert.equal(rest.diagnostics.scrubbedSamples, 0);
  }
  assert.equal(full.diagnostics.scrubbedSamples, 0);
  const slots = decodeSnapshot(full.state).slots;
  assert.equal(slots.filter(x => x.kind === 'buffer').reduce((total, x) => total + x.data.byteLength, 0), 8 * (capacity + 1));
  assert.equal(slots.filter(x => x.name.startsWith('grains/')).length, 40);
  assert.equal(slots.some(x => x.name === 'history/readAge' || x.name === 'grains/allocated'), false);
  writeFileSync(`candidate-live-granular-${sampleRate}.wav`, encodeWav([full.outputs.main[0]], sampleRate));
  // Tiny onset age survives write/rate cancellation in the public packed module.
  const extreme = Math.fround(3.4028234663852886e38), tiny = 2 ** -149;
  const tinyRows = liveGrainRows(128, n => ({ input: n === 1 ? extreme : 0, trigger: n === 1, age: tiny, rate: 1, seconds: 0 }));
  const tinyResult = await renderOffline(processor, { sampleRate, duration: (128 - .25) / sampleRate, inputs: { controls: liveGrainPorts(tinyRows) } });
  assert.deepEqual(tinyResult.outputs.main, liveGrainReference(capacity, maxGrains, sampleRate, tinyRows));
  assert.equal(tinyResult.outputs.main[0][2], Math.fround(extreme * tiny / maxGrains));
  assert.equal(tinyResult.diagnostics.scrubbedSamples, 0);
  reports.push({ sampleRate, frames, maxError, comparedChannels: 8, snapshotSplits: [128, 1280, 2048, 2560], stateBytes: full.state.byteLength, scrubbedSamples: 0 });
}
const memoryFrames = 131200, processor = makeMemoryProcessor();
const recorded = await renderOffline(processor, { sampleRate: 48000, duration: (memoryFrames - .25) / 48000 });
assert.deepEqual(recorded.outputs.main[1].slice(7), new Float32Array(memoryFrames - 7).fill(8));
assert(recorded.outputs.main[0][65536] > .1); assert(recorded.outputs.main[0][131072] > .1);
assert(recorded.outputs.main[0].every(x => Number.isFinite(x) && x >= 0 && x <= .25));
const slots = decodeSnapshot(recorded.state).slots;
assert.equal(slots.find(x => x.name === 'history/pcm')!.data.byteLength, 8 * 65537);
assert.equal(decodeScalar('i32', slots.find(x => x.name === 'history/head')!.data), 128);
const compiled = await compile(processor, { sampleRate: 48000 }), driver = await compiled.driver.instantiate();
const memoryBytes = driver.memory.buffer.byteLength;
for (let n = 0; n < memoryFrames / 128; n++) driver.process();
assert.equal(driver.memory.buffer.byteLength, memoryBytes); assert.equal(driver.scrubbedSamples(), 0); assert.equal(recorded.diagnostics.scrubbedSamples, 0);
const diagnostic = { sampleRate: 48000, frames: memoryFrames, capacity: 65536, maxGrains: 8, acceptedWrites: memoryFrames, wraps: 2, memoryBytes, wasmBytes: compiled.wasm.byteLength, wasmSHA256: createHash('sha256').update(compiled.wasm).digest('hex'), limitation: 'Active offline/Node-driver bounded memory; no browser/device/realtime clearance' };
writeFileSync('live-granular-results.json', JSON.stringify({ status: 'CANDIDATE', runtime: 'NOT_CLEARED', reports, diagnostic }, null, 2));
console.log(JSON.stringify({ reports, diagnostic }));
