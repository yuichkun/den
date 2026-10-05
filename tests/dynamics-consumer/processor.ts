import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { dynamics, type DynamicsMode } from '@denaudio/den/dynamics';

export function makeProcessor(operation: DynamicsMode) {
  return defineProcessor(ctx => {
    const input = audioInput({ channels: 4, name: 'main' });
    const output = audioOutput({ channels: 4, name: 'main' });
    const threshold = param.f32({ default: -12, min: -120, max: 24, automationRate: 'a-rate' }).named('threshold');
    const ratio = param.f32({ default: 4, min: 1, max: 100, automationRate: 'a-rate' }).named('ratio');
    const knee = param.f32({ default: 6, min: 0, max: 48, automationRate: 'a-rate' }).named('knee');
    const range = param.f32({ default: 36, min: 0, max: 120, automationRate: 'a-rate' }).named('range');
    const attack = param.f32({ default: 0.003, min: 0, max: 30, automationRate: 'a-rate' }).named('attack');
    const release = param.f32({ default: 0.07, min: 0, max: 30, automationRate: 'a-rate' }).named('release');
    const detectorAttack = param.f32({ default: 0.001, min: 0, max: 30, automationRate: 'a-rate' }).named('detectorAttack');
    const detectorRelease = param.f32({ default: 0.01, min: 0, max: 30, automationRate: 'a-rate' }).named('detectorRelease');
    const unit = instantiate(dynamics, { sampleRate: ctx.sampleRate, mode: 'rms', operation, hysteresisDb: 3 }, { name: 'dynamics' });
    return { process() { forSample(i => {
      const result = unit.tick(input.ch(0).at(i), input.ch(1).at(i), input.ch(2).at(i), input.ch(3).at(i), {
        thresholdDb: threshold.at(i), ratio: ratio.at(i), kneeDb: knee.at(i), rangeDb: range.at(i),
        attack: attack.at(i), release: release.at(i), detectorAttack: detectorAttack.at(i), detectorRelease: detectorRelease.at(i), reset: bool(false),
      });
      [result.left, result.right, result.envelope, result.gainDb].forEach((sample, ch) => output.ch(ch).at(i).write(sample));
    }); } };
  });
}
