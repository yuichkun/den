import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compile } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import browserProcessor, { makeProcessor } from './processor.ts';
import { reference, maxError, rms, signal } from './oracle.mjs';
const reports = [], bands = [{ frequencyHz: 300, q: 4, gain: .5 }, { frequencyHz: 1000, q: 6, gain: 1 }, { frequencyHz: 3500, q: 4, gain: .8 }];
for (const rate of [44100, 48000, 96000]) {
  const config = { sampleRate: rate, bands }, p = makeProcessor(config), inputs = signal(rate), n = inputs[0].length;
  const render = (start, end, restore) => renderOffline(p, { sampleRate: rate, duration: (end - start - .25) / rate, inputs: { main: inputs.map(x => x.slice(start, end)) }, restore });
  const whole = await render(0, n), expected = reference(config, inputs), errors = whole.outputs.main.map((channel, ch) => maxError(channel, expected[ch]));
  assert(errors.every(x => x < 3e-6)); assert.equal(whole.diagnostics.scrubbedSamples, 0); assert(rms(whole.outputs.main[0]) > .0001);
  for (const split of [128, 256, 384, 4096]) {
    const first = await render(0, split), continued = await render(split, n, first.state);
    assert.deepEqual(continued.outputs.main, whole.outputs.main.map(x => x.slice(split))); assert.deepEqual(continued.state, whole.state);
  }
  const silent = await renderOffline(p, { sampleRate: rate, duration: (n - .25) / rate, inputs: { main: [new Float32Array(n), ...inputs.slice(1)] } });
  assert(silent.outputs.main[0].every(x => x === 0)); assert.equal(silent.diagnostics.scrubbedSamples, 0);
  reports.push({ sampleRate: rate, bands, frames: n, errors, snapshotOffsets: [128, 256, 384, 4096], continuation: 'bit-identical PCM and final state', silentModulator: true, scrubbedSamples: 0 });
  const browserInput = signal(rate, 4096).slice(0, 2);
  const browserConfig = { sampleRate: rate, bands: [{ frequencyHz: 1000, q: 4, gain: 1 }] };
  const browserExpected = reference(browserConfig, [...browserInput, new Float32Array(4096).fill(.01), new Float32Array(4096).fill(.01), new Float32Array(4096)]);
  const browser = await renderOffline(browserProcessor, { sampleRate: rate, duration: (4096 - .25) / rate, inputs: { main: browserInput } });
  const browserErrors = browser.outputs.main.slice(0, 2).map((channel, ch) => maxError(channel, browserExpected[ch]));
  assert(browserErrors.every(x => x < 3e-6)); assert.equal(browser.diagnostics.scrubbedSamples, 0);
  [1, 1, Math.fround(.01), Math.fround(.01), 0].forEach((value, ch) => assert(browser.outputs.main[ch + 2].every(x => x === value)));
  reports.at(-1).browserComposition = { errors: browserErrors, renderedDefaultControls: 'exact', scrubbedSamples: 0 };
}
// Cost measurement is an explicit eight-band native graph, not an extrapolation from one band.
const maximum = { sampleRate: 48000, bands: Array.from({ length: 8 }, (_, i) => ({ frequencyHz: 100 * 80 ** (i / 7), q: 4, gain: 1 })) };
const begin = performance.now(), compiled = await compile(makeProcessor(maximum), { sampleRate: 48000 }), compileMs = performance.now() - begin;
const instance = await compiled.driver.instantiate(), memoryBytes = instance.memory.buffer.byteLength;
const inputs = signal(48000, 128), output = new Float32Array(128), write = () => inputs.forEach((x, ch) => instance.writeInput('main', ch, x));
write(); const cold = performance.now(); instance.process(); const coldQuantumMs = performance.now() - cold;
for (let i = 0; i < 127; i++) instance.process();
const costs = []; for (let i = 0; i < 512; i++) { const t = performance.now(); write(); instance.process(); instance.readOutput('main', 0, output); costs.push(performance.now() - t); assert(output.every(Number.isFinite)); }
costs.sort((a, b) => a - b); assert.equal(instance.memory.buffer.byteLength, memoryBytes); assert.equal(instance.scrubbedSamples(), 0);
const cost = { sampleRate: 48000, bands: 8, compileMs, coldQuantumMs, memoryBytes, wasmBytes: compiled.wasm.byteLength, wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'), warmupBlocks: 128, measuredBlocks: 512, p50Ms: costs[256], p99Ms: costs[506], maxMs: costs.at(-1), includesInputOutputCopies: true, processMaxRssBytes: process.resourceUsage().maxRSS * 1024, limitation: 'Local Node driver; no realtime or concurrency acceptance' };
// Original analytic tones, all channels at their actual level; no normalization.
const rate = 48000, n = 96000, modulator = new Float32Array(n), carrier = new Float32Array(n);
for (let i = 0; i < n - 12000; i++) { const envelope = i % 16000 < 10000 ? .65 : 0; modulator[i] = envelope * (Math.sin(2 * Math.PI * 1000 * i / rate) + .25 * Math.sin(2 * Math.PI * 3500 * i / rate)); carrier[i] = .35 * (Math.sin(2 * Math.PI * 300 * i / rate) + Math.sin(2 * Math.PI * 1000 * i / rate) + Math.sin(2 * Math.PI * 3500 * i / rate)); }
const audition = await renderOffline(makeProcessor({ sampleRate: rate, bands }), { sampleRate: rate, duration: (n - .25) / rate, inputs: { main: [modulator, carrier, new Float32Array(n).fill(.005), new Float32Array(n).fill(.025), new Float32Array(n)] } });
assert.equal(audition.diagnostics.scrubbedSamples, 0);
const file = 'candidate-filterbank-vocoder-48000.wav', wav = encodeWav([modulator, carrier, audition.outputs.main[0]], rate); writeFileSync(file, wav);
const audio = { file, sha256: createHash('sha256').update(wav).digest('hex'), status: 'CANDIDATE', humanApproved: false, sampleRate: rate, frames: n, channels: ['original modulator', 'original carrier', 'vocoder'], bands, attack: .005, release: .025, normalization: 'none', drainSamples: 12000, drainSeconds: .25, limitation: 'Finite observation of exponential tail; not exact mathematical silence or speech-quality evidence' };
writeFileSync('filterbank-vocoder-results.json', JSON.stringify({ reports, cost, audio }, null, 2)); console.log(JSON.stringify({ reports, cost, audio }));
