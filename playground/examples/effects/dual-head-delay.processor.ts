import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { dualHeadDelay } from '@denaudio/den/dual-head-delay';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const seconds = param.f32({ default: 0.15, min: 0.01, max: 0.5, automationRate: 'a-rate' }).named('seconds');
  const delay = instantiate(dualHeadDelay, {
    sampleRate, maxDelaySeconds: 0.5, transitionSamples: 1024,
  }, { name: 'delay' });
  return { process() { forSample(i => {
    // Change seconds while playing: two heads crossfade instead of sweeping pitch.
    const wet = delay.tick(input.ch(0).at(i), seconds.at(i), bool(false));
    output.ch(0).at(i).write(wet.output);
  }); } };
});
