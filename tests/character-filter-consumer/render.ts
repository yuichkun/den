import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { audioInput, audioOutput, compile, defineProcessor, forSample, inspect, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { characterFilter } from '@denaudio/den/character-filter';
import { characterReference } from './reference.ts';

const measurements: object[] = [];
const peak = (x: ArrayLike<number>) => Array.from(x).reduce((a, b) => Math.max(a, Math.abs(b)), 0);
function wav(name: string, signal: Float32Array, sampleRate: number) {
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(36 + signal.byteLength, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(32, 34); header.write('data', 36); header.writeUInt32LE(signal.byteLength, 40);
  writeFileSync(name, Buffer.concat([header, Buffer.from(signal.buffer, signal.byteOffset, signal.byteLength)]));
}
for (const sampleRate of [44100, 48000, 96000]) {
  const n = 16384;
  const channels = [
    Float32Array.from({ length: n }, (_, i) => .7 * Math.sin(2 * Math.PI * 173 * i / sampleRate) + .15 * Math.sin(2 * Math.PI * 997 * i / sampleRate)),
    Float32Array.from({ length: n }, (_, i) => 100 * 80 ** (i / (n - 1))),
    Float32Array.from({ length: n }, (_, i) => .5 + .5 * Math.sin(2 * Math.PI * i / n)),
    Float32Array.from({ length: n }, (_, i) => 1 + 15 * i / (n - 1)),
    new Float32Array(n),
  ];
  channels[4][127] = 1; channels[4][129] = 1;
  const processor = defineProcessor(() => {
    const input = audioInput({ channels: 5, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
    const unit = instantiate(characterFilter, { sampleRate }, { name: 'character' });
    return { process() { forSample(i => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), input.ch(1).at(i), input.ch(2).at(i), input.ch(3).at(i), input.ch(4).at(i).gt(0)))); } };
  });
  const options = (data: Float32Array[], restore?: Uint8Array) => ({ sampleRate, duration: (data[0].length - .25) / sampleRate, inputs: { main: data }, restore });
  const start = performance.now(), compiled = await compile(processor, { sampleRate }), compileWallMs = performance.now() - start;
  const renderStart = performance.now(), whole = await renderOffline(processor, options(channels)), offlineWallMs = performance.now() - renderStart;
  const output = whole.outputs.main[0], expected = characterReference(sampleRate, channels).output;
  assert.equal(output.length, n); assert.equal(whole.diagnostics.scrubbedSamples, 0); assert(output.every(Number.isFinite)); assert(peak(output) <= .50000006);
  let maximumError = 0; for (let i = 0; i < n; i++) maximumError = Math.max(maximumError, Math.abs(output[i] - expected[i]));
  assert(maximumError < 9e-8, 'independent nonlinear reference: ' + maximumError);
  const repeated = await renderOffline(processor, options(channels)); assert.deepEqual(repeated.outputs.main[0], output);
  const prefix = await renderOffline(processor, options(channels.map(x => x.slice(0, n / 2))));
  const continued = await renderOffline(processor, options(channels.map(x => x.slice(n / 2)), prefix.state));
  assert.deepEqual(continued.outputs.main[0], output.slice(n / 2)); assert.deepEqual(continued.state, whole.state);
  const cold = await renderOffline(processor, options(channels.map(x => x.slice(n / 2)))); assert.notDeepEqual(cold.outputs.main[0], continued.outputs.main[0]);
  assert.equal(Object.keys(inspect(whole.state).slots).length, 4); assert(compiled.wasm.byteLength < 16000);
  for (const [index, name] of ['input', 'pole-hz', 'resonance', 'drive', 'reset'].entries()) writeFileSync(`candidate-character-${name}-${sampleRate}.f32`, new Uint8Array(channels[index].buffer));
  writeFileSync(`candidate-character-output-${sampleRate}.f32`, new Uint8Array(output.buffer));
  writeFileSync(`candidate-character-reference-${sampleRate}.f64`, new Uint8Array(expected.buffer));
  wav(`candidate-character-input-${sampleRate}.wav`, channels[0], sampleRate); wav(`candidate-character-output-${sampleRate}.wav`, output, sampleRate);
  const paths = [channels[0], output].map((signal, channel) => {
    const points = Array.from({ length: 1024 }, (_, i) => { const v = signal[Math.floor(i * n / 1024)]; return `${i},${128 + channel * 256 - v * 110}`; }).join(' ');
    return `<polyline fill="none" stroke="${channel ? '#1a7' : '#67c'}" points="${points}"/>`;
  });
  writeFileSync(`candidate-character-waveform-${sampleRate}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="512" viewBox="0 0 1024 512"><rect width="1024" height="512" fill="white"/><text x="8" y="16">CANDIDATE ${sampleRate} Hz, input top / output bottom, fixed +/-1 scale, no normalization</text><path d="M0 128H1024M0 384H1024" stroke="#ccc"/>${paths.join('')}</svg>`);
  measurements.push({ sampleRate, frames: n, maximumError, peak: peak(output), rms: Math.sqrt(output.reduce((a, b) => a + b * b, 0) / n), scrubs: whole.diagnostics.scrubbedSamples, stateSlots: 4, snapshotBytes: whole.state.byteLength, wasmBytes: compiled.wasm.byteLength, compileWallMs, offlineWallMs, repeatedPcm: 'exact', snapshotContinuation: 'exact', realTimeClearance: false });
}
writeFileSync('character-filter-evidence.json', JSON.stringify({ status: 'CANDIDATE', measurements, settings: 'Stored input, poleHz, resonance, drive and reset f32 arrays are the full sample-accurate recipe.' }, null, 2));
