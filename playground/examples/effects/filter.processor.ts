import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { filter } from '@denaudio/den/filter';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const cutoff = param.f32({ default: 900, min: 40, max: 8000, automationRate: 'a-rate' }).named('cutoff');
  const resonance = param.f32({ default: 0.7, min: 0.5, max: 3, automationRate: 'a-rate' }).named('resonance');
  const lowpass = instantiate(filter, { sampleRate }, { name: 'lowpass' });
  return { process() { forSample(i => {
    output.ch(0).at(i).write(lowpass.tick(input.ch(0).at(i), cutoff.at(i), resonance.at(i), bool(false)));
  }); } };
});
