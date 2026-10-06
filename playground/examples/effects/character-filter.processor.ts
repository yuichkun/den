import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { characterFilter } from '@denaudio/den/character-filter';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  // poleHz tunes each saturating pole, rather than an overall -3 dB cutoff.
  const poleHz = param.f32({ default: 1200, min: 40, max: 8000, automationRate: 'a-rate' }).named('poleHz');
  const resonance = param.f32({ default: 0.4, min: 0, max: 0.9, automationRate: 'a-rate' }).named('resonance');
  const drive = param.f32({ default: 3, min: 0.1, max: 12, automationRate: 'a-rate' }).named('drive');
  const filter = instantiate(characterFilter, { sampleRate }, { name: 'character' });
  return { process() { forSample(i => {
    const wet = filter.tick(input.ch(0).at(i), poleHz.at(i), resonance.at(i), drive.at(i), bool(false));
    output.ch(0).at(i).write(wet.mul(0.25));
  }); } };
});
