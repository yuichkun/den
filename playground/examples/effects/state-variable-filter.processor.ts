import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { stateVariableFilter } from '@denaudio/den/state-variable-filter';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 2 });
  const cutoff = param.f32({ default: 660, min: 40, max: 8000, automationRate: 'a-rate' }).named('cutoff');
  const q = param.f32({ default: 0.8, min: 0.5, max: 2, automationRate: 'a-rate' }).named('q');
  const filter = instantiate(stateVariableFilter, { sampleRate }, { name: 'svf' });
  return { process() { forSample(i => {
    // One tick shares two integrator states across five available responses.
    const bands = filter.tick(input.ch(0).at(i), cutoff.at(i), q.at(i), bool(false));
    output.ch(0).at(i).write(bands.lowpass.mul(0.7));
    output.ch(1).at(i).write(bands.bandpass.mul(0.7));
  }); } };
});
