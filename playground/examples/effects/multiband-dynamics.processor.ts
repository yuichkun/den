import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { multibandDynamics } from '@denaudio/den/multiband-dynamics';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 2 });
  const output = audioOutput({ name: 'main', channels: 2 });
  const thresholdDb = param.f32({ default: -28, min: -42, max: -12, automationRate: 'a-rate' }).named('thresholdDb');
  const ratio = param.f32({ default: 4, min: 1, max: 10, automationRate: 'a-rate' }).named('ratio');
  const unit = instantiate(multibandDynamics, { sampleRate, bands: [
    { mode: 'rms', operation: 'compressor' },
    { mode: 'rms', operation: 'compressor' },
    { mode: 'rms', operation: 'compressor' },
  ] }, { name: 'multiband' });
  return { process() { forSample(i => {
    const common = {
      ratio: ratio.at(i), kneeDb: f32(6), rangeDb: f32(24),
      attack: f32(0.005), release: f32(0.12), detectorAttack: f32(0.001), detectorRelease: f32(0.015),
    };
    const wet = unit.tick(input.ch(0).at(i), input.ch(1).at(i), {
      lowCutoffHz: f32(300), highCutoffHz: f32(1800), reset: bool(false), bands: [
        { ...common, thresholdDb: thresholdDb.at(i) },
        { ...common, thresholdDb: thresholdDb.at(i).sub(4) },
        { ...common, thresholdDb: thresholdDb.at(i).sub(8) },
      ],
    });
    // These are phase-compensated band sums; original dry PCM is not aligned.
    output.ch(0).at(i).write(wet.left.mul(0.8));
    output.ch(1).at(i).write(wet.right.mul(0.8));
  }); } };
});
