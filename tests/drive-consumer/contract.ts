import { drive, reduction, type DriveConfig, type DriveCurve, type DriveQuality, type ReductionConfig } from '@denaudio/den/drive';
import { bool, defineProcessor, f32, forSample, instantiate } from '@unworklet/core';
const curve: DriveCurve = 'asymmetric', quality: DriveQuality = 'adaa';
const config: DriveConfig = { sampleRate: 48000, curve, quality, dcBlockHz: 20 };
const reductionConfig: ReductionConfig = { sampleRate: 48000 };
defineProcessor(() => {
  const shaper = instantiate(drive, config, { name: 'shaper' });
  const crusher = instantiate(reduction, reductionConfig, { name: 'crusher' });
  return { process() { forSample(() => {
    const x = shaper.tick(f32(0.5), f32(4), f32(0.7), bool(false));
    crusher.tick(x, f32(12), f32(3), f32(0.25), bool(false));
  }); } };
});
// @ts-expect-error Curves are fixed, explicitly named choices.
const unknownCurve: DriveConfig = { sampleRate: 48000, curve: 'tape' };
// @ts-expect-error There is no oversampling claim or mode.
const unknownQuality: DriveConfig = { sampleRate: 48000, curve: 'soft', quality: '4x' };
void unknownCurve; void unknownQuality;
