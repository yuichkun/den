import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { drive } from '@denaudio/den/drive';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const gain = param.f32({ default: 8, min: 1, max: 24, automationRate: 'a-rate' }).named('gain');
  const mix = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('mix');
  // First-order ADAA is not oversampling. Curve and quality are construction-fixed.
  const shaper = instantiate(drive, { sampleRate, curve: 'soft', quality: 'adaa', dcBlockHz: 20 }, { name: 'drive' });
  return { process() { forSample(i => {
    output.ch(0).at(i).write(shaper.tick(input.ch(0).at(i), gain.at(i), mix.at(i), bool(false)).mul(0.22));
  }); } };
});
