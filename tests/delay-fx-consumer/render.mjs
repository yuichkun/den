import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { renderOffline, encodeWav } from '@unworklet/offline';
import { processor } from './processor.ts';
for (const sampleRate of [44100, 48000, 96000]) {
  const length = 2048, input = [new Float32Array(length), new Float32Array(length)]; input[0][0] = 1; input[1][16] = -0.5;
  const result = await renderOffline(processor, { sampleRate, duration: length / sampleRate, inputs: { main: input } });
  assert.equal(result.outputs.main[0].length, length); assert.equal(result.diagnostics.scrubbedSamples, 0);
  const g = Math.tan(Math.PI * 1000 / sampleRate), norm = 1 / (1 + 2 * g + g * g), b0 = g * g * norm;
  for (let ch = 0; ch < 2; ch++) {
    const history = []; let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const delay = Math.fround((ch === 0 ? 8 : 12) / sampleRate) * sampleRate;
    for (let n = 0; n < length; n++) {
      const position = n - delay, before = Math.floor(position), alpha = position - before;
      const at = index => index >= 0 && index < n ? history[index] : 0;
      const wet = Math.fround(at(before) * (1 - alpha) + at(before + 1) * alpha);
      const filtered = b0 * (wet + 2 * x1 + x2) - 2 * (g * g - 1) * norm * y1 - (1 - 2 * g + g * g) * norm * y2;
      x2 = x1; x1 = wet; y2 = y1; y1 = filtered;
      history[n] = Math.fround(input[ch][n] + Math.fround(Math.fround(filtered) * 0.5));
      assert(Math.abs(result.outputs.main[ch][n] - wet) < 3e-6, `${sampleRate}/${ch}/${n}`);
    }
  }
  writeFileSync(`fx-${sampleRate}.wav`, encodeWav(result.outputs.main, sampleRate));
  const paths = result.outputs.main.map((samples, ch) => `<polyline fill="none" stroke="${ch ? '#d06020' : '#2050c0'}" points="${Array.from(samples, (x, n) => `${30 + n / 4},${150 - x * 100}`).join(' ')}"/>`).join('');
  writeFileSync(`fx-${sampleRate}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="570" height="260"><rect width="570" height="260" fill="white"/><text x="20" y="20">CANDIDATE delay FX: stereo, ${sampleRate} Hz</text>${paths}</svg>`);
}
