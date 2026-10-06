import { audioInput, audioOutput, defineProcessor, forSample, instantiate, param, f32, bool } from '@unworklet/core';
import { filter } from '@denaudio/den/filter';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const cutoff = param.f32({ default: 900, min: 40, max: 8000, automationRate: 'a-rate' }).named('cutoff');
  const low = instantiate(filter, { sampleRate }, { name: 'low' });
  return { process() { forSample(i => {
    output.ch(0).at(i).write(low.tick(input.ch(0).at(i), cutoff.at(i), f32(0.7), bool(false)));
  }); } };
});
