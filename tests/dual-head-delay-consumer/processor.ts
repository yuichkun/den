import { audioInput, audioOutput, defineProcessor, f32, f64, forSample, instantiate, param } from '@unworklet/core';
import { dualHeadDelay, type DualHeadDelayConfig } from '@denaudio/den/dual-head-delay';

export function makeProcessor(transitionSamples = 257, maxDelaySeconds?: number) {
  return defineProcessor(ctx => {
    const input = audioInput({ name: 'main', channels: 2 }), output = audioOutput({ name: 'main', channels: 4 });
    const capacity = maxDelaySeconds ?? 128 / ctx.sampleRate;
    const seconds = param.f32({ default: 8 / ctx.sampleRate, min: 1 / ctx.sampleRate, max: capacity, automationRate: 'a-rate' }).named('timeSeconds');
    const mix = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('mix');
    const config: DualHeadDelayConfig = { sampleRate: ctx.sampleRate, maxDelaySeconds: capacity, transitionSamples };
    const delay = instantiate(dualHeadDelay, config, { name: 'delay' });
    return { process() { forSample(i => {
      const dry = input.ch(0).at(i), tap = delay.tick(dry, seconds.at(i), input.ch(1).at(i).gt(0));
      const amount = f64(mix.at(i)).clamp(0, 1);
      output.ch(0).at(i).write(tap.output);
      output.ch(1).at(i).write(f32(tap.timingRejected));
      output.ch(2).at(i).write(f32(tap.transitioning));
      output.ch(3).at(i).write(f32(f64(dry).mul(f64(1).sub(amount)).add(f64(tap.output).mul(amount))));
    }); } };
  });
}
// @ts-expect-error There is no pitch-ratio/time-stretch API.
const notPitchShift: DualHeadDelayConfig = { sampleRate: 48000, pitchRatio: 2 };
void notPitchShift;
