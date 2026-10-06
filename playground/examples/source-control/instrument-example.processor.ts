import { audioOutput, bool, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { exampleOscillator, exampleFilter } from '@denaudio/den/instrument-example';

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const cutoff = param.f32({ default: 500, min: 30, max: 6000, automationRate: 'a-rate' }).named('cutoff');
  // These replacement parts have the same tick contracts as the instrument's parts.
  const source = instantiate(exampleOscillator, { sampleRate, waveform: 'sine' }, { name: 'source' });
  const filter = instantiate(exampleFilter, { sampleRate }, { name: 'filter' });
  return { process() { forSample(i => {
    const wave = source.tick(f32(330), bool(false));
    output.ch(0).at(i).write(filter.tick(wave, cutoff.at(i), f32(0.707), bool(false)).mul(0.3));
  }); } };
});
