import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { spectralBlur } from '@denaudio/den/spectral-texture';

export default defineProcessor(() => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const amount = param.f32({ default: 0.7, min: 0, max: 1, automationRate: 'a-rate' }).named('amount');
  // Framewise triangular magnitude blur. It is not a phase-vocoder or time stretch.
  const blur = instantiate(spectralBlur, { size: 256, hopSize: 64, radius: 4 }, { name: 'blur' });
  return { process() { forSample((i, everyNSamples) => {
    const wet = blur.tick(input.ch(0).at(i), amount.at(i), bool(false), everyNSamples);
    output.ch(0).at(i).write(wet.mul(0.6));
  }); } };
});
