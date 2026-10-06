import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { frequencyShifter, FREQUENCY_SHIFTER_LATENCY_SAMPLES } from '@denaudio/den/frequency-shifter';

export const latencySamples = FREQUENCY_SHIFTER_LATENCY_SAMPLES;
export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const shiftHz = param.f32({ default: 75, min: -200, max: 200, automationRate: 'a-rate' }).named('shiftHz');
  const mix = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('mix');
  // Additive frequency translation changes harmonic spacing; it is not pitch scaling.
  const shifter = instantiate(frequencyShifter, { sampleRate }, { name: 'shifter' });
  return { process() { forSample(i => {
    const wet = shifter.tick(input.ch(0).at(i), {
      shiftHz: shiftHz.at(i), mix: mix.at(i), bypass: bool(false), reset: bool(false),
    });
    output.ch(0).at(i).write(wet.mul(0.7));
  }); } };
});
