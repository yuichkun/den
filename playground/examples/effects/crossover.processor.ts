import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { crossover } from '@denaudio/den/crossover';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 2 });
  const cutoff = param.f32({ default: 500, min: 60, max: 6000, automationRate: 'a-rate' }).named('cutoff');
  const split = instantiate(crossover, { sampleRate }, { name: 'split' });
  return { process() { forSample(i => {
    // Audition the LR4 low band on the left and high band on the right.
    const bands = split.tick(input.ch(0).at(i), cutoff.at(i), bool(false));
    output.ch(0).at(i).write(bands.low);
    output.ch(1).at(i).write(bands.high);
  }); } };
});
