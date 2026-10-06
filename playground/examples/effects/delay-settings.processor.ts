import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { chorusSettings } from '@denaudio/den/delay-settings';
import { delayFx } from '@denaudio/den/delay-fx';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 2 });
  const output = audioOutput({ name: 'main', channels: 2 });
  // These are plain configuration values, not a parameter or preset framework.
  const s = chorusSettings.parameters;
  const mix = param.f32({ default: s.mix, min: 0, max: 1, automationRate: 'a-rate' }).named('mix');
  const rate = param.f32({ default: s.rateHz, min: 0.1, max: 3, automationRate: 'a-rate' }).named('rate');
  const depth = param.f32({ default: s.depthSeconds, min: 0, max: 0.008, automationRate: 'a-rate' }).named('depth');
  const chorus = instantiate(delayFx, { sampleRate, ...chorusSettings.config }, { name: 'chorus' });
  return { process() { forSample(i => {
    const wet = chorus.tick(input.ch(0).at(i), input.ch(1).at(i), {
      timeLeftSeconds: f32(s.timeLeftSeconds), timeRightSeconds: f32(s.timeRightSeconds),
      sync: bool(s.sync), bpm: f32(s.bpm), beatsLeft: f32(s.beatsLeft), beatsRight: f32(s.beatsRight),
      feedback: f32(s.feedback), cutoffHz: f32(s.cutoffHz), mix: mix.at(i),
      rateHz: rate.at(i), depthSeconds: depth.at(i), bypass: bool(s.bypass), reset: bool(s.reset),
    });
    output.ch(0).at(i).write(wet.left);
    output.ch(1).at(i).write(wet.right);
  }); } };
});
