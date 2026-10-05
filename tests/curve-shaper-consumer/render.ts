import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compile } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import { makeProcessor } from './processor.ts';
import { curveShaperReference } from './reference.ts';
const reports: object[] = [];
for (const sampleRate of [44100, 48000, 96000]) for (const quality of ['direct', 'adaa'] as const) for (const pointCount of [2, 17]) {
  const n = 8192;
  const input = Float32Array.from({ length: n }, (_, i) => .5 * (Math.sin(2 * Math.PI * 173 * i / sampleRate) + .3 * Math.sin(2 * Math.PI * 997 * i / sampleRate)));
  const gain = Float32Array.from(input, (_, i) => i < 4096 ? 6 : .5 + 12 * (i % 149) / 148);
  const mix = Float32Array.from(input, (_, i) => i < 4096 ? 1 : (i % 137) / 136);
  const reset = Float32Array.from(input, (_, i) => [0, 127, 128, 2049, 6144].includes(i) ? 1 : 0);
  const ordinates = Array.from({ length: pointCount }, (_, j) => Float32Array.from(input, (_, i) => i < 4096 ? Math.sin((-1 + 2 * j / (pointCount - 1)) * Math.PI / 2) : Math.sin(j * .7 + Math.floor(i / 43) * .2)));
  const channels = [input, gain, mix, reset, ...ordinates];
  const captureBegin = performance.now(), processor = makeProcessor(pointCount, quality), captureMs = performance.now() - captureBegin;
  const compileBegin = performance.now(), compiled = await compile(processor, { sampleRate }), compileMs = performance.now() - compileBegin;
  const driver = await compiled.driver.instantiate();
  const beforeMemory = driver.memory.buffer.byteLength, output = new Float32Array(n);
  const times: number[] = [];
  for (let offset = 0; offset < n; offset += 128) {
    const renderBlock = (instance: typeof driver, destination: Float32Array, destOffset: number) => {
      instance.writeInput('main', 0, input.slice(offset, offset + 128));
      instance.writeInput('main', 1, reset.slice(offset, offset + 128));
      instance.writeParam('gain', gain.slice(offset, offset + 128));
      instance.writeParam('mix', mix.slice(offset, offset + 128));
      ordinates.forEach((ch, j) => instance.writeParam(`ordinate-${j}`, ch.slice(offset, offset + 128)));
      const start = performance.now(); instance.process(); times.push(performance.now() - start);
      const block = new Float32Array(128); instance.readOutput('main', 0, block); destination.set(block, destOffset);
    };
    renderBlock(driver, output, offset);
  }
  const offline = (start: number, end: number, restore?: Uint8Array) => renderOffline(processor, {
    sampleRate, duration: (end - start) / sampleRate, inputs: { main: [input.slice(start, end), reset.slice(start, end)] },
    params: Object.fromEntries([['gain', gain], ['mix', mix], ...ordinates.map((ch, j) => [`ordinate-${j}`, ch] as const)].map(([key, ch]) => [key, Array.from((ch as Float32Array).slice(start, end))])), restore,
  });
  const whole = await offline(0, n), first = await offline(0, n / 2), continued = await offline(n / 2, n, first.state);
  assert.deepEqual(output, whole.outputs.main[0]);
  assert.deepEqual(continued.outputs.main[0], output.slice(n / 2));
  assert.equal(driver.scrubbedSamples(), 0); assert.equal(whole.diagnostics.scrubbedSamples, 0); assert.equal(continued.diagnostics.scrubbedSamples, 0);
  assert.equal(driver.memory.buffer.byteLength, beforeMemory); assert(output.every(Number.isFinite));
  const expected = curveShaperReference(channels, quality);
  let maximumOracleError = 0; for (let i = 0; i < n; i++) maximumOracleError = Math.max(maximumOracleError, Math.abs(output[i] - expected[i]));
  assert(maximumOracleError < 8e-7, `quadrature error ${maximumOracleError}`);
  const candidate = `candidate-curve-shaper-${pointCount}-${quality}-${sampleRate}.wav`;
  writeFileSync(candidate, encodeWav([output], sampleRate));
  times.sort((a, b) => a - b);
  reports.push({ sampleRate, quality, pointCount, frames: n, candidate, maximumOracleError, captureMs, compileMs,
    graphBytes: JSON.stringify(compiled.graph).length, wasmBytes: compiled.wasm.byteLength, memoryBytes: beforeMemory,
    processP50Ms: times[Math.floor(times.length / 2)], processMaxMs: times.at(-1), stateBytes: first.state.byteLength,
    parameterEdits: 'Native a-rate gain/mix/all ordinate writes every quantum, including per-sample ordinate modulation',
    resetSamples: [0, 127, 128, 2049, 6144], snapshotSplit: 4096, scrubbedSamples: 0,
    limitation: 'Single local Node driver diagnostic; process timing excludes copies and is not browser deadline/capacity evidence' });
}
writeFileSync('curve-shaper-results.json', JSON.stringify({ status: 'CANDIDATE', reports }, null, 2));
console.log(JSON.stringify({ reports }));
