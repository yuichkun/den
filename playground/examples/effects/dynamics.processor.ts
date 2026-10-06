import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { dynamics } from '@denaudio/den/dynamics';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 2 });
  const output = audioOutput({ name: 'main', channels: 2 });
  const thresholdDb = param.f32({ default: -30, min: -48, max: -12, automationRate: 'a-rate' }).named('thresholdDb');
  const ratio = param.f32({ default: 4, min: 1, max: 12, automationRate: 'a-rate' }).named('ratio');
  const compressor = instantiate(dynamics, { sampleRate, mode: 'rms', operation: 'compressor' }, { name: 'compressor' });
  return { process() { forSample(i => {
    const left = input.ch(0).at(i), right = input.ch(1).at(i);
    // The last two signal arguments are an explicit stereo sidechain.
    const wet = compressor.tick(left, right, left, right, {
      thresholdDb: thresholdDb.at(i), ratio: ratio.at(i), kneeDb: f32(6), rangeDb: f32(36),
      attack: f32(0.003), release: f32(0.12), detectorAttack: f32(0.001), detectorRelease: f32(0.02),
      reset: bool(false),
    });
    output.ch(0).at(i).write(wet.left);
    output.ch(1).at(i).write(wet.right);
  }); } };
});
