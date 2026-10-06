import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { spectralGate } from '@denaudio/den/spectral-gate';

export default defineProcessor(() => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  // Threshold is coherent-window bin amplitude, not RMS or dBFS.
  const threshold = param.f32({ default: 0.035, min: 0, max: 0.15, automationRate: 'a-rate' }).named('threshold');
  const floor = param.f32({ default: 0.15, min: 0, max: 1, automationRate: 'a-rate' }).named('floor');
  const gate = instantiate(spectralGate, { size: 256, hopSize: 64 }, { name: 'gate' });
  return { process() { forSample((i, everyNSamples) => {
    const wet = gate.tick(input.ch(0).at(i), threshold.at(i), floor.at(i), bool(false), everyNSamples);
    output.ch(0).at(i).write(wet.mul(0.8));
  }); } };
});
