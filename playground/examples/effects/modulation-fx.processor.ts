import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { flanger } from '@denaudio/den/modulation-fx';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 2 });
  const output = audioOutput({ name: 'main', channels: 2 });
  const rate = param.f32({ default: 0.3, min: 0.05, max: 3, automationRate: 'a-rate' }).named('rate');
  const depth = param.f32({ default: 0.002, min: 0, max: 0.003, automationRate: 'a-rate' }).named('depth');
  const feedback = param.f32({ default: 0.4, min: 0, max: 0.65, automationRate: 'a-rate' }).named('feedback');
  const effect = instantiate(flanger, { sampleRate, maxDelaySeconds: 0.02, stereoPhaseCycles: 0.5 }, { name: 'flanger' });
  return { process() { forSample(i => {
    const wet = effect.tick(input.ch(0).at(i), input.ch(1).at(i), {
      delaySeconds: f32(0.004), depthSeconds: depth.at(i), rateHz: rate.at(i),
      feedback: feedback.at(i), mix: f32(0.5), bypass: bool(false), reset: bool(false),
    });
    output.ch(0).at(i).write(wet.left.mul(0.65));
    output.ch(1).at(i).write(wet.right.mul(0.65));
  }); } };
});
