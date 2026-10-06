import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { delayFx } from '@denaudio/den/delay-fx';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 2 });
  const output = audioOutput({ name: 'main', channels: 2 });
  const time = param.f32({ default: 0.18, min: 0.03, max: 0.4, automationRate: 'a-rate' }).named('time');
  const feedback = param.f32({ default: 0.35, min: 0, max: 0.6, automationRate: 'a-rate' }).named('feedback');
  const mix = param.f32({ default: 0.7, min: 0, max: 1, automationRate: 'a-rate' }).named('mix');
  const delay = instantiate(delayFx, { sampleRate, maxDelaySeconds: 0.7, tone: 'lowpass' }, { name: 'delay' });
  return { process() { forSample(i => {
    const wet = delay.tick(input.ch(0).at(i), input.ch(1).at(i), {
      timeLeftSeconds: time.at(i), timeRightSeconds: time.at(i).mul(1.5),
      feedback: feedback.at(i), cutoffHz: f32(3200), mix: mix.at(i),
      sync: bool(false), bpm: f32(120), beatsLeft: f32(0.75), beatsRight: f32(1),
      rateHz: f32(0), depthSeconds: f32(0), bypass: bool(false), reset: bool(false),
    });
    output.ch(0).at(i).write(wet.left.mul(0.6));
    output.ch(1).at(i).write(wet.right.mul(0.6));
  }); } };
});
