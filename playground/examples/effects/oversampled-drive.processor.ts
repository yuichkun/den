import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { oversampledDrive, OVERSAMPLED_DRIVE_LATENCY_SAMPLES } from '@denaudio/den/oversampled-drive';

export const latencySamples = OVERSAMPLED_DRIVE_LATENCY_SAMPLES;
export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const gain = param.f32({ default: 8, min: 1, max: 24, automationRate: 'a-rate' }).named('gain');
  const mix = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('mix');
  // Fixed 2x rate conversion; matched 32-sample bulk delay with FIR precursors.
  const shaper = instantiate(oversampledDrive, { sampleRate, factor: 2, curve: 'soft' }, { name: 'drive' });
  return { process() { forSample(i => {
    output.ch(0).at(i).write(shaper.tick(input.ch(0).at(i), gain.at(i), mix.at(i), bool(false)).mul(0.2));
  }); } };
});
