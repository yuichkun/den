import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { audioInput, audioOutput, compile, defineProcessor, forSample, instantiate } from '@unworklet/core';
import { oversampledDrive } from '../../dist/oversampled-drive.js';
const factor = Number(process.argv[2] ?? 4);
const start = performance.now();
const processor = defineProcessor(() => {
  const input = audioInput({ name: 'main', channels: 4 }), output = audioOutput({ name: 'main', channels: 1 });
  const unit = instantiate(oversampledDrive, { sampleRate: 48000, factor, curve: 'soft' }, { name: 'drive' });
  return { process() { forSample(i => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), input.ch(1).at(i), input.ch(2).at(i), input.ch(3).at(i).gt(0)))); } };
});
const captureMs = performance.now() - start;
console.error(JSON.stringify({ stage: 'captured', factor, captureMs, rss: process.memoryUsage().rss }));
const compileStart = performance.now(), compiled = await compile(processor, { sampleRate: 48000 });
const compileMs = performance.now() - compileStart;
console.error(JSON.stringify({ stage: 'compiled', factor, compileMs, wasmBytes: compiled.wasm.byteLength }));
const driver = await compiled.driver.instantiate(), memoryBytes = driver.memory.buffer.byteLength;
const x = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i * .7) * .5), out = new Float32Array(128);
for (let ch = 0; ch < 4; ch++) driver.writeInput('main', ch, ch === 0 ? x : new Float32Array(128).fill(ch === 1 ? 8 : ch === 2 ? 1 : 0));
const times = [];
for (let n = 0; n < 128; n++) { const start = performance.now(); driver.process(); times.push(performance.now() - start); }
driver.readOutput('main', 0, out);
assert(out.every(Number.isFinite)); assert(out.some(x => x !== 0)); assert.equal(driver.scrubbedSamples(), 0); assert.equal(driver.memory.buffer.byteLength, memoryBytes);
const coldMs = times[0]; times.sort((a,b) => a-b);
console.log(JSON.stringify({ status: 'CANDIDATE', factor, captureMs, compileMs, graphBytes: JSON.stringify(compiled.graph).length, wasmBytes: compiled.wasm.byteLength,
  memoryBytes, coldMs, p50Ms: times[64], maxMs: times.at(-1), maxRssKiB: process.resourceUsage().maxRSS, scrubbedSamples: 0,
  limitation: 'Local single Node instance,128-frame process calls including startup. Excludes copies/browser scheduling; no realtime deadline claim.' }));
