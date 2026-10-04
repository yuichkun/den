import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compile } from '@unworklet/core';
import { processor } from './processor.ts';
const compiled = await compile(processor, { sampleRate: 48000 });
const built = readFileSync(`dist/assets/${readdirSync('dist/assets').find(name => name.startsWith('processor-') && name.endsWith('.wasm'))}`);
assert.deepEqual(new Uint8Array(built), compiled.wasm, 'benchmark must match the packed browser WASM');
const instance = await compiled.driver.instantiate();
const settings = { timeLeft: 0.075, timeRight: 0.1, feedback: 0.95, mix: 1, cutoff: 1000, sync: 0, bpm: 120, beatsLeft: 1, beatsRight: 1.5, rate: 2, depth: 0.001, bypass: 0, reset: 0 };
for (const [key, value] of Object.entries(settings)) instance.writeParam(key, new Float32Array(128).fill(value));
for (let ch = 0; ch < 2; ch++) instance.writeInput('main', ch, new Float32Array(128).fill(0.05));
const warmup = 1000, blocks = 4500;
for (let n = 0; n < warmup; n++) instance.process();
const times = [], start = performance.now();
for (let n = 0; n < blocks; n++) { const t = performance.now(); instance.process(); times.push(performance.now() - t); }
const elapsedMs = performance.now() - start;
times.sort((a, b) => a - b);
const result = { wasmBytes: built.length, wasmSHA256: createHash('sha256').update(built).digest('hex'), node: process.version,
  method: 'Existing unworklet driver, byte-identical packed browser WASM, fixed a-rate controls and DC stereo input; excludes browser scheduling and input/output copy overhead',
  settings, input: 0.05, warmup, blocks, framesPerBlock: 128, sampleRate: 48000, audioSeconds: blocks * 128 / 48000, budgetMs: 128 / 48,
  elapsedMs, meanMs: times.reduce((a, b) => a + b, 0) / blocks, p50Ms: times[Math.floor(blocks * 0.5)], p99Ms: times[Math.floor(blocks * 0.99)], maxMs: times.at(-1),
  limitation: 'Host-dependent diagnostic, not AudioWorklet deadline acceptance; real-time captured waveform remains a separate mandatory gate' };
writeFileSync('performance.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
