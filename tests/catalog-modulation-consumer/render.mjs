import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { renderOffline, encodeWav } from '@unworklet/offline';
import { processor } from './processor.ts';
const records = [];
const energy = a => a.reduce((s, x) => s + x * x, 0);
for (const sampleRate of [44100, 48000, 96000]) {
  const frames = 65536, input = new Float32Array(frames); input[0] = 1;
  const result = await renderOffline(processor, { sampleRate, duration: frames / sampleRate, inputs: { main: [input] } });
  assert.equal(result.diagnostics.scrubbedSamples, 0);
  assert.equal(result.outputs.main.length, 9);
  for (const a of result.outputs.main) { assert.equal(a.length, frames); assert(a.every(Number.isFinite)); }
  const out = result.outputs.main;
  assert.equal(out[0][0], 0.5); assert.deepEqual(out[0], out[1]);
  assert(Math.abs(energy(out[2]) - 1) < 1e-6, 'allpass impulse energy');
  for (let n = 0; n < 512; n++) for (let ch = 0; ch < 2; ch++) {
    const expected = n > 0 && n % 8 === 0 && (n / 8 - 1) % 2 === ch ? 0.5 ** (n / 8 - 1) : 0;
    assert(Math.abs(out[3 + ch][n] - expected) < 4e-6, 'alternating ping-pong timing');
  }
  assert(Math.abs(out[5][4] - 0.5) < 2e-6); assert(Math.abs(out[6][4] + 0.5) < 2e-6);
  assert(Math.abs(out[5][12] - 0.5) < 2e-6); assert(Math.abs(out[6][12] - 0.5) < 2e-6);
  assert(out[7].slice(0, Math.round(0.0297 * sampleRate) - 1).every(x => x === 0));
  assert(energy(out[7]) + energy(out[8]) > 0.1);
  const resumed = await renderOffline(processor, { sampleRate, duration: 128 / sampleRate, inputs: { main: [new Float32Array(128)] }, restore: result.state });
  assert.equal(resumed.diagnostics.scrubbedSamples, 0);
  for (const [name, channels] of [['flanger', [0, 1]], ['phaser', [2]], ['pingpong', [3, 4]], ['multitap', [5, 6]], ['reverb', [7, 8]]]) {
    writeFileSync(`${name}-${sampleRate}.wav`, encodeWav(channels.map(ch => out[ch]), sampleRate));
  }
  records.push({ sampleRate, frames, scrubbedSamples: result.diagnostics.scrubbedSamples, energies: out.map(energy), snapshotBytes: result.state.byteLength });
}
writeFileSync('verification.json', JSON.stringify({ status: 'CANDIDATE', method: 'Isolated packed consumer, public subpath imports, actual offline WASM rendering. Independent comb/allpass/echo/tap and FDN decay checks are in the source unit suites.', limitation: 'No human approval, browser execution or scheduler/deadline claim.', records }, null, 2));
