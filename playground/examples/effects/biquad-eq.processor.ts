import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { biquadEq } from '@denaudio/den/biquad-eq';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const frequency = param.f32({ default: 660, min: 40, max: 8000, automationRate: 'a-rate' }).named('frequency');
  const q = param.f32({ default: 1.5, min: 0.5, max: 6, automationRate: 'a-rate' }).named('q');
  const gainDb = param.f32({ default: 9, min: -18, max: 12, automationRate: 'a-rate' }).named('gainDb');
  // mode is construction-fixed: edit to 'lowShelf' or 'highShelf' and rerun.
  const eq = instantiate(biquadEq, { sampleRate, mode: 'peaking' }, { name: 'eq' });
  return { process() { forSample(i => {
    output.ch(0).at(i).write(eq.tick(input.ch(0).at(i), frequency.at(i), q.at(i), gainDb.at(i), bool(false)).mul(0.5));
  }); } };
});
