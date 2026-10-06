import { audioOutput, bool, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { virtualAnalogSource } from '@denaudio/den/virtual-analog';
import { lfo } from '@denaudio/den/lfo';

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const width = param.f32({ default: 0.5, min: 0.15, max: 0.85, automationRate: 'a-rate' }).named('pulseWidth');
  const source = instantiate(virtualAnalogSource, { sampleRate, waveform: 'pulse' }, { name: 'pulse' });
  const mod = instantiate(lfo, { sampleRate }, { name: 'lfo' });
  return { process() { forSample(i => {
    const duty = width.at(i).add(mod.tick(f32(0.6), bool(false), f32(0)).mul(0.1));
    output.ch(0).at(i).write(source.tick({ frequencyHz: f32(165), duty, reset: bool(false) }).mul(0.13));
  }); } };
});
