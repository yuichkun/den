import { expect, test } from 'vitest';
import { audioInput, audioOutput, defineProcessor, f32, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { spectralGate } from '../src/spectral-gate.js';

// At threshold=max-f32 every bin is closed, with gain 1/4. The independent
// oracle is then exactly x[t-N]/4, including every reset phase. This analytic
// limit covers large exhaustive reset schedules without a huge dense DFT run.
for (const rate of [44100, 48000, 96000]) test(`uniform-floor gate resets every large hop phase at ${rate}`, async () => {
  for (const [size, hop] of [[128, 32], [256, 128], [512, 256], [1024, 256], [1024, 512]]) {
    const p = defineProcessor(() => {
      const input = audioInput({ channels: 2, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
      const gate = instantiate(spectralGate, { size, hopSize: hop }, { name: 'gate' });
      return { process() { forSample((i, everyNSamples) => output.ch(0).at(i).write(gate.tick(input.ch(0).at(i), f32(3.4028234663852886e38), f32(0.25), input.ch(1).at(i).gt(0), everyNSamples))); } };
    });
    const count = Math.ceil((3 * size + hop * (size + hop + 1)) / 128) * 128;
    const input = Float32Array.from({ length: count }, (_, n) => n < count - size ? 0.45 * Math.sin(n * 0.0317) + 0.2 * Math.cos(n * 0.223) : 0);
    const reset = new Float32Array(count);
    for (let phase = 0; phase < hop; phase++) reset[2 * size + phase * (size + hop + 1)] = 1;
    reset.fill(1, size - 1, size + 4);
    const result = await renderOffline(p, { sampleRate: rate, duration: (count - 0.25) / rate, inputs: { main: [input, reset] } });
    let lastReset = -1, error = 0;
    for (let n = 0; n < count; n++) {
      if (reset[n]) lastReset = n;
      error = Math.max(error, Math.abs(result.outputs.main[0][n] - (n - size > lastReset ? input[n - size] * 0.25 : 0)));
    }
    expect(error).toBeLessThan(4e-8); expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
}, 60000);
