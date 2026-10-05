import { audioInput, audioOutput, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { oversampledDrive, OVERSAMPLED_DRIVE_LATENCY_SAMPLES, type OversampledDriveConfig } from '@denaudio/den/oversampled-drive';
import type { DriveCurve } from '@denaudio/den/drive';
export function makeProcessor(factor: 2 | 4, curve: DriveCurve) {
  return defineProcessor(ctx => {
    const input = audioInput({ name: 'main', channels: 2 }), output = audioOutput({ name: 'main', channels: 1 });
    const gain = param.f32({ default: 1, min: 0, max: 32, automationRate: 'a-rate' }).named('gain');
    const mix = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('mix');
    const config: OversampledDriveConfig = { sampleRate: ctx.sampleRate, factor, curve };
    const unit = instantiate(oversampledDrive, config, { name: 'oversampled' });
    return { process() { forSample(i => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i),gain.at(i),mix.at(i),input.ch(1).at(i).gt(0)))); } };
  });
}
const latency: 32 = OVERSAMPLED_DRIVE_LATENCY_SAMPLES;
// @ts-expect-error Only the validated fixed factors are admitted.
const invalidFactor: OversampledDriveConfig = { sampleRate: 48000, factor: 8, curve: 'hard' };
void latency; void invalidFactor;
