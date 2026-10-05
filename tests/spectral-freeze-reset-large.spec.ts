import { expect, test } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { spectralFreeze } from '../src/spectral-freeze.js';
import { directFreezeWola, maxError } from './spectral-freeze-consumer/oracle.mjs';

// Independent circular-shift identity of the DFT proves the rotation sign and
// supplies a linear-cost time-indexed oracle for exhaustive large reset phases.
for (const rate of [44100, 48000, 96000]) test(`mirrored clock stays aligned through every large reset offset at ${rate}`, async () => {
  for (const [size, hop] of [[128, 32], [256, 128], [512, 256], [1024, 256], [1024, 512]]) {
    const p = defineProcessor(() => {
      const input = audioInput({ channels: 3, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
      const unit = instantiate(spectralFreeze, { size, hopSize: hop }, { name: 'freeze' });
      return { process() { forSample((i, everyNSamples) => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), input.ch(2).at(i).gt(0), input.ch(1).at(i).gt(0), everyNSamples))); } };
    });
    const count = Math.ceil((4 * size + hop * (size + hop + 1)) / 128) * 128;
    const input = Float32Array.from({ length: count }, (_, n) => 0.5 * Math.sin(n * 0.0731) + 0.2 * Math.cos(n * 0.2197));
    const reset = new Float32Array(count), freeze = new Float32Array(count).fill(1);
    for (let phase = 0; phase < hop; phase++) reset[2 * size + phase * (size + hop + 1)] = 1;
    reset.fill(1, size - 1, size + 4);
    // Alternate release/capture, including eager H>128 non-commit boundaries.
    for (let n = 0; n < count; n += size + 128) freeze[n] = 0;
    const result = await renderOffline(p, { sampleRate: rate, duration: (count - 0.25) / rate, inputs: { main: [input, reset, freeze] } });
    expect(maxError(result.outputs.main[0], directFreezeWola(input, reset, freeze, size, hop, 'shift'))).toBeLessThan(2e-7);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
}, 120000);
