import assert from 'node:assert/strict';
import { renderOffline } from '@unworklet/offline';
import processor from './processor.ts';
import { simulate } from './oracle.mjs';

const frames = 4096;
const params = {
  amount: Array.from({ length: frames }, (_, n) => [0, 1, .5, .75][Math.floor(n / 1024)]),
  carrierLevel: Array.from({ length: frames }, (_, n) => n >= 2304 && n < 2560 ? 0 : n >= 1536 && n < 1792 ? .125 : .5),
  modulatorLevel: Array.from({ length: frames }, (_, n) => n >= 2048 && n < 2304 ? 0 : 1),
  samePattern: Array.from({ length: frames }, (_, n) => +(n >= 1280 && n < 2048)),
  flip: Array.from({ length: frames }, (_, n) => +(n >= 768 && n < 896 || n >= 3072 && n < 3200)),
  reset: Array.from({ length: frames }, (_, n) => +(n === 127 || n >= 2687 && n <= 2721)),
};
const expected = simulate(frames, params), reports = [];
for (const sampleRate of [44100, 48000, 96000]) {
  const full = await renderOffline(processor, { sampleRate, duration: (frames - .25) / sampleRate, params });
  const audio = full.outputs.main;
  assert.equal(full.diagnostics.scrubbedSamples, 0);
  const errors = audio.map((channel, ch) => {
    assert.equal(channel.length, frames); let error = 0;
    for (let n = 0; n < frames; n++) { assert(Number.isFinite(channel[n])); error = Math.max(error, Math.abs(channel[n] - expected[ch][n])); }
    assert(error < (ch < 2 ? 3e-6 : 1e-7), `rate ${sampleRate} channel ${ch} independent error ${error}`); return error;
  });
  for (const split of [128, 512, 896, 1664, 2176, 2688, 2816, 3328]) {
    const cut = (start, end) => Object.fromEntries(Object.entries(params).map(([name, values]) => [name, values.slice(start, end)]));
    const first = await renderOffline(processor, { sampleRate, duration: (split - .25) / sampleRate, params: cut(0, split) });
    const resumed = await renderOffline(processor, { sampleRate, duration: (frames - split - .25) / sampleRate, params: cut(split), restore: first.state });
    assert.equal(resumed.diagnostics.scrubbedSamples, 0);
    audio.forEach((channel, ch) => assert.deepEqual(resumed.outputs.main[ch], channel.slice(split), `rate ${sampleRate} split ${split} channel ${ch}`));
    assert.deepEqual(resumed.state, full.state);
  }
  reports.push({ sampleRate, frames, channels: 12, maximumErrors: errors, snapshotSplits: [128, 512, 896, 1664, 2176, 2688, 2816, 3328], scrubbedSamples: 0 });
}
console.log(JSON.stringify({ reports, status: 'CANDIDATE', runtimeStatus: 'NOT_CLEARED' }));
