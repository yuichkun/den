// Invoke one size per process after build: node tests/probes/spectral-cost.mjs 64
// This is a local driver diagnostic, never a browser realtime acceptance gate.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { audioInput, audioOutput, compile, defineProcessor, defineSubgraph, f32, f64, forSample, instantiate, state } from '@unworklet/core';
import { spectralFft, spectralForEach } from '../../dist/spectral-fft.js';
import { stftIdentity } from '../../dist/spectral.js';
import { createStftIdentity } from '../../dist/spectral-stft.js';

const size = Number(process.argv[2] ?? 64), mode = process.argv[3] ?? 'stft';
const hop = Number(process.argv[4] ?? size / 4);
const dispatchPeriod = mode === 'candidate-stft' ? Math.min(hop, 128) : hop;
const candidateStft = defineSubgraph(config => createStftIdentity(config, 1024));
const startCapture = performance.now();
const processor = defineProcessor(() => {
  const input = audioInput({ channels: 1, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
  if (mode === 'stft' || mode === 'candidate-stft') {
    const stft = instantiate(mode === 'stft' ? stftIdentity : candidateStft, { size, hopSize: hop }, { name: 'stft' });
    return { process() { forSample((i, everyNSamples) => output.ch(0).at(i).write(stft.tick(input.ch(0).at(i), i.lt(0), everyNSamples))); } };
  }
  assert.equal(mode, 'kernel');
  const fft = instantiate(spectralFft, { size }, { name: 'fft' });
  const history = state.buffer.f64({ size });
  const spectrum = [state.buffer.f64({ size }), state.buffer.f64({ size })];
  const result = state.buffer.f64({ size });
  const cursor = state.i32(0);
  return { process() { forSample((i, everyNSamples) => {
    everyNSamples(hop, () => {
      const frame = fft.transform(n => history.read(cursor.read().add(n).mod(size)), () => f64(0), false);
      spectralForEach(size, k => { spectrum[0].write(k, frame.real(k)); spectrum[1].write(k, frame.imag(k)); });
      const inverse = fft.transform(n => spectrum[0].read(n), n => spectrum[1].read(n), true);
      spectralForEach(size, n => result.write(cursor.read().add(n).mod(size), inverse.real(n)));
    });
    output.ch(0).at(i).write(f32(result.read(cursor.read())));
    history.write(cursor.read(), f64(input.ch(0).at(i)));
    cursor.write(cursor.read().add(1).mod(size));
  }); } };
});
const captureMs = performance.now() - startCapture;
console.error(JSON.stringify({ stage: 'captured', size, mode, captureMs, rssBytes: process.memoryUsage().rss }));
const compileStart = performance.now(), compiled = await compile(processor, { sampleRate: 48000 });
const compileMs = performance.now() - compileStart;
console.error(JSON.stringify({ stage: 'compiled', size, mode, compileMs, wasmBytes: compiled.wasm.byteLength, rssBytes: process.memoryUsage().rss }));
const instantiateStart = performance.now(), instance = await compiled.driver.instantiate();
const instantiateMs = performance.now() - instantiateStart;
console.error(JSON.stringify({ stage: 'instantiated', size, mode, instantiateMs, rssBytes: process.memoryUsage().rss }));
const input = Float32Array.from({ length: 128 }, (_, n) => Math.sin(2 * Math.PI * 7 * n / 128) * 0.25), output = new Float32Array(128);
const memoryBytes = instance.memory.buffer.byteLength;
instance.writeInput('main', 0, input);
const coldStart = performance.now(); instance.process(); instance.readOutput('main', 0, output);
const coldQuantumMs = performance.now() - coldStart;
console.error(JSON.stringify({ stage: 'first-quantum', size, mode, coldQuantumMs, rssBytes: process.memoryUsage().rss }));
const startupTimes = [coldQuantumMs];
for (let n = 0; n < 127; n++) { const start = performance.now(); instance.process(); startupTimes.push(performance.now() - start); }
const processTimes = [], fullTimes = [], burstTimes = [], emptyTimes = [];
for (let n = 0; n < 512; n++) {
  const fullStart = performance.now(); instance.writeInput('main', 0, input);
  const processStart = performance.now(); instance.process();
  const processMs = performance.now() - processStart;
  instance.readOutput('main', 0, output);
  fullTimes.push(performance.now() - fullStart); processTimes.push(processMs);
  (dispatchPeriod <= 128 || (128 + n) * 128 % dispatchPeriod === 0 ? burstTimes : emptyTimes).push(processMs);
  assert(output.every(Number.isFinite));
}
const stats = values => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return { count: values.length, p50Ms: values[Math.floor(values.length * 0.5)], p99Ms: values[Math.floor(values.length * 0.99)], maxMs: values.at(-1) };
};
assert.equal(instance.scrubbedSamples(), 0); assert.equal(instance.memory.buffer.byteLength, memoryBytes);
console.log(JSON.stringify({ status: 'CANDIDATE', node: process.version, unworklet: '0.4.1', mode, size, hop, dispatchPeriod, sampleRate: 48000, captureMs, compileMs, instantiateMs, coldQuantumMs,
  wasmBytes: compiled.wasm.byteLength, wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'), graphBytes: JSON.stringify(compiled.graph).length,
  fixedMemoryBytes: memoryBytes, copyBytesPerQuantum: 1024, process: stats(processTimes), withCopies: stats(fullTimes), burst: stats(burstTimes), empty: stats(emptyTimes),
  startupQuanta: stats(startupTimes),
  maxRssBytes: process.resourceUsage().maxRSS * 1024, scrubbedSamples: 0,
  limitation: 'Single local Node instance; wall-clock includes host jitter. Kernel mode is FFT/IFFT framing only, not WOLA. No browser or realtime-capacity acceptance.' }));
