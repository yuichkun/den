import assert from 'node:assert/strict';
import { renderOffline } from '@unworklet/offline';
import processor from './processor.ts';
import { spatialPorts, spatialReference, maxError } from './reference.ts';

const frames = 16384, width = 2048;
const params = {
  level: Array.from({ length: frames }, (_, n) => n < 10240 || n >= 13056 && n < 14080 ? .25 : 0),
  mix: Array.from({ length: frames }, (_, n) => n < 2048 ? 0 : n < 4096 ? .5 : 1),
  bypass: Array.from({ length: frames }, (_, n) => +(n >= 12032 && n < 14080)),
  reset: Array.from({ length: frames }, (_, n) => +(n === 127 || n >= 12287 && n < 12292)),
  ratio: Array.from({ length: frames }, (_, n) => n < 6144 ? 1 : n < 8192 ? 2 : n < 10240 ? .5 : 1),
  pitchMix: Array.from({ length: frames }, (_, n) => n < 4096 || n >= 12288 ? .5 : 1),
  retrigger: Array.from({ length: frames }, (_, n) => +(n >= 10368 && n < 10497)),
  disturb: Array.from({ length: frames }, (_, n) => +(n >= 11520 && n < 12032)),
};
const phase = new Float32Array(frames), signal = new Float32Array(frames);
let counter = 0;
for (let n = 0; n < frames; n++) {
  if (params.reset[n]) counter = 0;
  phase[n] = counter;
  signal[n] = Math.fround(Math.fround(Math.sin(2 * Math.PI * counter / 128)) * params.level[n]);
  counter = (counter + 1) % 256;
}
const ports = spatialPorts(frames, { 0: n => signal[n], 1: n => params.mix[n], 2: n => params.bypass[n], 3: n => params.reset[n],
  4: n => params.ratio[n], 5: n => params.pitchMix[n], 6: n => params.retrigger[n] });
const altered = ports.map(ch => ch.slice());
altered[0] = Float32Array.from(signal, (v, n) => Math.fround(v + params.disturb[n] * .5));
const reports = [];
for (const sampleRate of [44100, 48000, 96000]) {
  const h = spatialReference(ports, sampleRate).output;
  const p = spatialReference(ports, sampleRate, width).output;
  const q = spatialReference(altered, sampleRate, width).output;
  const expected = [...h, ...p.slice(0, 2), ...q.slice(0, 2), signal, phase,
    Float32Array.from(p[0], (v, n) => Math.fround(v - q[0][n])), Float32Array.from(p[1], (v, n) => Math.fround(v - q[1][n])),
    p[2], ...Object.values(params).map(values => Float32Array.from(values))];
  const render = (start, end, restore) => renderOffline(processor, { sampleRate, duration: (end - start - .25) / sampleRate,
    params: Object.fromEntries(Object.entries(params).map(([name, values]) => [name, values.slice(start, end)])), ...(restore ? { restore } : {}) });
  const whole = await render(0, frames);
  assert.equal(whole.outputs.main.length, 19); assert.equal(whole.diagnostics.scrubbedSamples, 0);
  const errors = whole.outputs.main.map((channel, ch) => {
    assert.equal(channel.length, frames); assert(channel.every(Number.isFinite));
    const error = maxError(channel, expected[ch]);
    assert(error < (ch < 7 || ch === 8 || ch === 9 ? 3e-6 : 1e-7), `spatial composition rate ${sampleRate} channel ${ch} error ${error}`);
    return error;
  });
  for (const split of [128, 4096, 7296, 10240, 12288, 13312]) {
    const first = await render(0, split), tail = await render(split, frames, first.state);
    assert.deepEqual(tail.outputs.main, whole.outputs.main.map(channel => channel.slice(split)));
    assert.deepEqual(tail.state, whole.state); assert.equal(tail.diagnostics.scrubbedSamples, 0);
  }
  reports.push({ sampleRate, frames, channels: 19, maximumErrors: errors, snapshotSplits: [128, 4096, 7296, 10240, 12288, 13312], scrubbedSamples: 0 });
}
console.log(JSON.stringify({ reports, status: 'CANDIDATE', runtimeStatus: 'NOT_CLEARED' }));
