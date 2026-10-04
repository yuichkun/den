import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { renderOffline, encodeWav } from '@unworklet/offline';
import { processor } from './processor.ts';
for (const sampleRate of [44100, 48000, 96000]) {
  const input = new Float32Array(256); input[0] = 1;
  const delaySeconds = Math.fround(2.5 / sampleRate);
  const result = await renderOffline(processor, { sampleRate, duration: 256 / sampleRate, inputs: { main: [input] }, params: { delay: [delaySeconds] } });
  assert.equal(result.outputs.main[0].length, 256);
  assert.equal(result.diagnostics.scrubbedSamples, 0);
  // A fractional impulse contributes only to frames 2 and 3.
  for (let n = 0; n < 256; n++) {
    const expected = n === 2 ? 3 - delaySeconds * sampleRate : n === 3 ? delaySeconds * sampleRate - 2 : 0;
    assert(Math.abs(result.outputs.main[0][n] - expected) < 2e-6);
  }
  writeFileSync(`delay-${sampleRate}.wav`, encodeWav(result.outputs.main, sampleRate));
  const points = Array.from(result.outputs.main[0].slice(0, 16), (x, n) => `${40 + n * 30},${180 - x * 280}`).join(' ');
  writeFileSync(`delay-${sampleRate}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="220"><rect width="540" height="220" fill="white"/><text x="20" y="20">CANDIDATE: 2.5-sample delay, ${sampleRate} Hz</text><polyline points="${points}" fill="none" stroke="blue"/></svg>`);
}
