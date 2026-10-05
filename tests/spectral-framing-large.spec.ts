import { expect, test } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { stftIdentity } from '../src/spectral.js';

function fixture(size: number, hopSize: number) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 2, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
    const stft = instantiate(stftIdentity, { size, hopSize }, { name: 'stft' });
    return { process() { forSample((i, everyNSamples) => output.ch(0).at(i).write(stft.tick(input.ch(0).at(i), input.ch(1).at(i).gt(0), everyNSamples))); } };
  });
}
const render = (p: ReturnType<typeof fixture>, rate: number, input: Float32Array, reset: Float32Array, restore?: Uint8Array) =>
  renderOffline(p, { sampleRate: rate, duration: (input.length - 0.25) / rate, inputs: { main: [input, reset] }, restore });

// Independent analytic identity: direct DFT tests separately prove the kernel;
// squared periodic sqrt-Hann windows sum to N/(2H), so output is x[t-N].
// This oracle has no FFT, ring indexing or implementation state recurrence.
function identityError(output: Float32Array, input: Float32Array, reset: Float32Array, latency: number) {
  let lastReset = -1, error = 0;
  for (let n = 0; n < output.length; n++) {
    if (reset[n]) lastReset = n;
    error = Math.max(error, Math.abs(output[n] - (n - latency > lastReset ? input[n - latency] : 0)));
  }
  return error;
}

for (const rate of [44100, 48000, 96000]) {
  test(`large identity tests every reset hop phase and exact latency at ${rate}`, async () => {
    for (const size of [256, 512, 1024]) for (const hop of [size / 2, size / 4]) {
      const frames = Math.ceil((3 * size + hop * (size + hop + 1)) / 128) * 128;
      const input = Float32Array.from({ length: frames }, (_, n) => n < frames - size ? (n % 521 === 0 ? 1 : 0.35 * Math.sin(n * 0.0317) + 0.2 * Math.cos(n * 0.223)) : 0);
      const reset = new Float32Array(frames);
      // All H reset phases, with at least N+H samples separating resets so
      // each trial has a nonzero reconstructed interval, not permanent silence.
      for (let phase = 0; phase < hop; phase++) reset[2 * size + phase * (size + hop + 1)] = 1;
      reset.fill(1, size - 1, size + 4);
      const result = await render(fixture(size, hop), rate, input, reset);
      expect(identityError(result.outputs.main[0], input, reset, size)).toBeLessThan(1.5e-7);
      expect(result.diagnostics.scrubbedSamples).toBe(0);
      expect(result.outputs.main[0].every(Number.isFinite)).toBe(true);
    }
  }, 60000);

  test(`persistent hop phase survives every quantum-offset snapshot at ${rate}`, async () => {
    for (const [size, hop] of [[256, 128], [512, 256], [1024, 256], [1024, 512]]) {
      const frames = 8 * size;
      const input = Float32Array.from({ length: frames }, (_, n) => n < frames - size ? 0.4 * Math.sin(n * 0.317) + 0.3 * Math.cos(n * 0.127) : 0);
      const reset = new Float32Array(frames);
      reset[2 * size + 13] = 1; reset[3 * size + 127] = 1; reset.fill(1, 5 * size - 1, 5 * size + 3);
      const p = fixture(size, hop), whole = await render(p, rate, input, reset);
      expect(identityError(whole.outputs.main[0], input, reset, size)).toBeLessThan(1.5e-7);
      for (const offset of [128, 256, 384, 512]) {
        const split = 3 * size + offset;
        const first = await render(p, rate, input.slice(0, split), reset.slice(0, split));
        const resumed = await render(p, rate, input.slice(split), reset.slice(split), first.state);
        expect(resumed.outputs.main[0]).toEqual(whole.outputs.main[0].slice(split));
        expect(resumed.diagnostics.scrubbedSamples).toBe(0);
      }
    }
  }, 60000);
}

test('large framing preserves finite quiet/full-range f32 and impulse polarity', async () => {
  const size = 1024, hop = 512, frames = 8192;
  for (const amplitude of [2 ** -149, 2 ** -130, 1e-29, 1, 3.4028234663852886e38]) {
    const input = Float32Array.from({ length: frames }, (_, n) => (n % 3 ? 1 : -1) * amplitude);
    const reset = new Float32Array(frames); reset[3071] = 1; reset.fill(1, 6143, 6148);
    const result = await render(fixture(size, hop), 48000, input, reset);
    expect(identityError(result.outputs.main[0], input, reset, size)).toBeLessThanOrEqual(Math.fround(amplitude) * 2e-7);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
}, 60000);
