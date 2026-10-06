import { audioOutput, bool, defineProcessor, f32, forSample, instantiate, param, state } from '@unworklet/core';
import { lfo, modulatePitch } from '@denaudio/den/lfo';
import { oscillator } from '@denaudio/den/oscillator';

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const rate = param.f32({ default: 5, min: 0, max: 12, automationRate: 'a-rate' }).named('rate');
  const depth = param.f32({ default: 0.8, min: 0, max: 12, automationRate: 'a-rate' }).named('depth');
  const mod = instantiate(lfo, { sampleRate }, { name: 'lfo' });
  const voice = instantiate(oscillator, { sampleRate, waveform: 'sine' }, { name: 'voice' });
  const frequency = state.f32(220).named('frequency');
  return { process() { forSample(i => {
    const wave = mod.tick(rate.at(i), bool(false), f32(0));
    // Depth is in semitones; materialize the helper result before the oscillator.
    frequency.write(modulatePitch(f32(220), wave, depth.at(i), 0.45 * sampleRate));
    output.ch(0).at(i).write(voice.tick(frequency.read(), bool(false)).mul(0.16));
  }); } };
});
