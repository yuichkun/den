import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { formantBank } from '@denaudio/den/formant-bank';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const frequencyRatio = param.f32({ default: 1, min: 0.5, max: 2, automationRate: 'a-rate' }).named('frequencyRatio');
  const resonanceScale = param.f32({ default: 1, min: 0.5, max: 2, automationRate: 'a-rate' }).named('resonanceScale');
  // Parallel bandpasses, not a speech synthesizer. The bank is fixed at build time.
  const formants = instantiate(formantBank, { sampleRate, bands: [
    { frequencyHz: 440, q: 3, gain: 0.8 },
    { frequencyHz: 1320, q: 5, gain: 0.5 },
    { frequencyHz: 2640, q: 7, gain: 0.3 },
  ] }, { name: 'formants' });
  return { process() { forSample(i => {
    output.ch(0).at(i).write(formants.tick(input.ch(0).at(i), frequencyRatio.at(i), resonanceScale.at(i), bool(false)));
  }); } };
});
