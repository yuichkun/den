import { audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { oscillator } from '@denaudio/den/oscillator';

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const frequency = param.f32({ default: 220, min: 40, max: 2000, automationRate: 'a-rate' }).named('frequency');
  // Waveform is a construction choice. Change 'saw' to 'sine' and Run again.
  const voice = instantiate(oscillator, { sampleRate, waveform: 'saw' }, { name: 'oscillator' });
  return { process() { forSample(i => {
    output.ch(0).at(i).write(voice.tick(frequency.at(i), bool(false)).mul(0.15));
  }); } };
});
