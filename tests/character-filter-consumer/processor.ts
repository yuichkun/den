import { audioInput, audioOutput, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { characterFilter, type CharacterFilterConfig } from '@denaudio/den/character-filter';

export default defineProcessor(({ sampleRate }) => {
  const config: CharacterFilterConfig = { sampleRate };
  const input = audioInput({ channels: 1, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
  const poleHz = param.f32({ default: 2000, min: 20, max: 20000, automationRate: 'a-rate' }).named('poleHz');
  const resonance = param.f32({ default: .7, min: 0, max: 1, automationRate: 'a-rate' }).named('resonance');
  const drive = param.f32({ default: 8, min: 0, max: 16, automationRate: 'a-rate' }).named('drive');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const unit = instantiate(characterFilter, config, { name: 'character' });
  return { process() { forSample(i => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), poleHz.at(i), resonance.at(i), drive.at(i), reset.at(i).gt(0)))); } };
});
