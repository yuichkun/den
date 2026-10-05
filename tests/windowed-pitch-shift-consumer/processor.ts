import { audioInput, audioOutput, defineProcessor, f32, f64, forSample, instantiate, param } from '@unworklet/core';
import { windowedPitchShift, type WindowedPitchShiftConfig } from '@denaudio/den/windowed-pitch-shift';

export function makeProcessor(windowSamples = 512) {
  return defineProcessor(ctx => {
    const input = audioInput({ name: 'main', channels: 3 }), output = audioOutput({ name: 'main', channels: 3 });
    const ratio = param.f32({ default: 1, min: .5, max: 2, automationRate: 'a-rate' }).named('ratio');
    const mix = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('mix');
    const config: WindowedPitchShiftConfig = { sampleRate: ctx.sampleRate, windowSamples };
    const shifter = instantiate(windowedPitchShift, config, { name: 'pitch' });
    return { process() { forSample(i => {
      const dry = input.ch(0).at(i);
      const result = shifter.tick(dry, { ratio: ratio.at(i), reset: input.ch(1).at(i).gt(0), retrigger: input.ch(2).at(i).gt(0) });
      const amount = f64(mix.at(i)).clamp(0, 1);
      output.ch(0).at(i).write(result.output);
      output.ch(1).at(i).write(f32(result.ratioRejected));
      // Explicit consumer-owned raw-dry blend: no latency alignment is implied.
      output.ch(2).at(i).write(f32(f64(dry).mul(f64(1).sub(amount)).add(f64(result.output).mul(amount))));
    }); } };
  });
}
// @ts-expect-error Fixed graph configuration has no duration/time-stretch API.
const notTimeStretch: WindowedPitchShiftConfig = { sampleRate: 48000, stretchRatio: 2 };
void notTimeStretch;
