import { audioInput, audioOutput, defineProcessor, forSample, instantiate } from '@unworklet/core';
import { frequencyShifter, FREQUENCY_SHIFTER_LATENCY_SAMPLES, type FrequencyShifterControls } from '@denaudio/den/frequency-shifter';

export const latencySamples: number = FREQUENCY_SHIFTER_LATENCY_SAMPLES;
export const processor = defineProcessor(ctx => {
  const input = audioInput({ channels: 5, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
  const shifter = instantiate(frequencyShifter, { sampleRate: ctx.sampleRate }, { name: 'shift' });
  return { process() { forSample(i => {
    const controls: FrequencyShifterControls = { shiftHz: input.ch(1).at(i), mix: input.ch(2).at(i),
      bypass: input.ch(3).at(i).gt(0), reset: input.ch(4).at(i).gt(0) };
    output.ch(0).at(i).write(shifter.tick(input.ch(0).at(i), controls));
  }); } };
});
export default processor;
