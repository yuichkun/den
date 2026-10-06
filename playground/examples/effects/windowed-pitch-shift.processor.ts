import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { windowedPitchShift } from '@denaudio/den/windowed-pitch-shift';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const ratio = param.f32({ default: 1.5, min: 0.5, max: 2, automationRate: 'a-rate' }).named('ratio');
  // Two windowed live readheads: pitch shifting, not independent duration control.
  const shifter = instantiate(windowedPitchShift, { sampleRate, windowSamples: 1024 }, { name: 'pitch' });
  return { process() { forSample(i => {
    const wet = shifter.tick(input.ch(0).at(i), { ratio: ratio.at(i), reset: bool(false), retrigger: bool(false) });
    output.ch(0).at(i).write(wet.output.mul(0.8));
  }); } };
});
