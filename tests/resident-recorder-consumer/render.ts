import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compile, decodeSnapshot } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import { capacity, makeProcessor } from './processor.ts';
import { takeReference } from './reference.ts';

const frames = 4096, reports = [];
const rows = Array.from({ length: frames }, (_, n) => ({ input: Math.fround(.65 * Math.sin(2 * Math.PI * n / 73) + .15 * Math.cos(n / 317)), record: n % 19 > 3, reset: n >= 2045 && n < 2049, position: Math.fround((n % 1152) + .25) }));
const loads = [{ frame: 0, data: Float32Array.from({ length: 127 }, (_, n) => .5 * Math.sin(2 * Math.PI * n / 61)) }, { frame: 1536, data: Float32Array.of(.25, -.5, 1e-35) }];
const inputs = (data: typeof rows) => ({ controls: [Float32Array.from(data, r => r.input), Float32Array.from(data, r => +r.record), Float32Array.from(data, r => +r.reset), Float32Array.from(data, r => r.position)] });
const expected = takeReference(capacity, rows, loads).output;
for (const sampleRate of [44100, 48000, 96000]) {
  const processor = makeProcessor(), split = 1280;
  const run = (start: number, end: number, restore?: Uint8Array) => renderOffline(processor, { sampleRate, duration: (end - start - .25) / sampleRate, inputs: inputs(rows.slice(start, end)), messages: loads.filter(x => x.frame >= start && x.frame < end).map(x => ({ name: 'load', payload: { data: x.data }, atQuantum: (x.frame - start) / 128 })), ...(restore ? { restore } : {}) });
  const full = await run(0, frames), first = await run(0, split), rest = await run(split, frames, first.state);
  full.outputs.main.forEach((channel, ch) => { assert.deepEqual(channel, expected[ch]); assert.deepEqual(rest.outputs.main[ch], channel.slice(split)); });
  assert.equal(full.diagnostics.scrubbedSamples, 0); assert.equal(rest.diagnostics.scrubbedSamples, 0);
  const bufferBytes = decodeSnapshot(full.state).slots.filter(x => x.kind === 'buffer').reduce((total, x) => total + x.data.byteLength, 0);
  assert.equal(bufferBytes, 12 * capacity + 8);
  writeFileSync(`candidate-resident-recorder-${sampleRate}.wav`, encodeWav([full.outputs.main[0], full.outputs.main[2]], sampleRate));
  reports.push({ sampleRate, frames, comparedChannels: 7, comparison: 'exact f32 equality for every output sample', snapshotSplit: split, bufferBytes, stateBytes: full.state.byteLength, scrubbedSamples: full.diagnostics.scrubbedSamples });
}
const compiled = await compile(makeProcessor(), { sampleRate: 48000 }), driver = await compiled.driver.instantiate(), memoryBytes = driver.memory.buffer.byteLength;
for (let n = 0; n < 64; n++) driver.process();
assert.equal(driver.memory.buffer.byteLength, memoryBytes); assert.equal(driver.scrubbedSamples(), 0);
const diagnostic = { sampleRate: 48000, blocks: 64, memoryBytes, wasmBytes: compiled.wasm.byteLength, wasmSHA256: createHash('sha256').update(compiled.wasm).digest('hex'), limitation: 'Node-driver bounded memory diagnostic with zero input; no browser/device/realtime execution claim' };
writeFileSync('resident-recorder-results.json', JSON.stringify({ status: 'CANDIDATE', runtime: 'NOT_CLEARED', reports, diagnostic }, null, 2));
console.log(JSON.stringify({ reports, diagnostic }));
