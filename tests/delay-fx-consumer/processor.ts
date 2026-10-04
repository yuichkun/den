import { audioInput, audioOutput, defineProcessor, forSample, instantiate, param, state } from '@unworklet/core';
import { delayFx } from './node_modules/@denaudio/den/dist/delay-fx.js';
export const processor = defineProcessor(ctx => {
  const input = audioInput({ channels: 2, name: 'main' });
  const output = audioOutput({ channels: 2, name: 'main' });
  const timeLeft = param.f32({ default: 8 / ctx.sampleRate, min: 0, max: 8, automationRate: 'a-rate' }).named('timeLeft');
  const timeRight = param.f32({ default: 12 / ctx.sampleRate, min: 0, max: 8, automationRate: 'a-rate' }).named('timeRight');
  const feedback = param.f32({ default: 0.5, min: 0, max: 0.95, automationRate: 'a-rate' }).named('feedback');
  const mix = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('mix');
  const cutoff = param.f32({ default: 1000, min: 20, max: 20000, automationRate: 'a-rate' }).named('cutoff');
  const sync = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('sync');
  const bpm = param.f32({ default: 120, min: 30, max: 300, automationRate: 'a-rate' }).named('bpm');
  const beatsLeft = param.f32({ default: 1, min: 0, max: 4, automationRate: 'a-rate' }).named('beatsLeft');
  const beatsRight = param.f32({ default: 1.5, min: 0, max: 4, automationRate: 'a-rate' }).named('beatsRight');
  const rate = param.f32({ default: 0, min: 0, max: 20, automationRate: 'a-rate' }).named('rate');
  const depth = param.f32({ default: 0, min: 0, max: 0.05, automationRate: 'a-rate' }).named('depth');
  const bypass = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('bypass');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const rejected = state.bool(false).named('timingRejected');
  const engine = instantiate(delayFx, { sampleRate: ctx.sampleRate, maxDelaySeconds: 0.1 }, { name: 'engine' });
  return { process() { forSample(i => {
    const result = engine.tick(input.ch(0).at(i), input.ch(1).at(i), {
      timeLeftSeconds: timeLeft.at(i), timeRightSeconds: timeRight.at(i), feedback: feedback.at(i), cutoffHz: cutoff.at(i), mix: mix.at(i),
      sync: sync.at(i).gt(0.5), bpm: bpm.at(i), beatsLeft: beatsLeft.at(i), beatsRight: beatsRight.at(i),
      rateHz: rate.at(i), depthSeconds: depth.at(i), bypass: bypass.at(i).gt(0.5), reset: reset.at(i).gt(0.5),
    });
    rejected.write(result.timingRejected);
    output.ch(0).at(i).write(result.left); output.ch(1).at(i).write(result.right);
  }); } };
}, { id: 'den.delay.fx.consumer.v1' });
