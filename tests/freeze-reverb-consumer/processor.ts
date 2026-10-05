import { audioInput, audioOutput, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { freezeReverb, type FreezeReverbConfig, type FreezeReverbControls } from '@denaudio/den/freeze-reverb';
export function makeProcessor(config: Omit<FreezeReverbConfig, 'sampleRate'> = {}) {
  return defineProcessor(ctx => {
    const input = audioInput({ name: 'main', channels: 3 }), output = audioOutput({ name: 'main', channels: 4 });
    const freeze = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('freeze');
    const fx = instantiate(freezeReverb, { ...config, sampleRate: ctx.sampleRate }, { name: 'tail' });
    return { process() { forSample(i => {
      const controls: FreezeReverbControls = { freeze: freeze.at(i).gte(.5), reset: input.ch(2).at(i).gt(0) };
      const r = fx.tick(input.ch(0).at(i), input.ch(1).at(i), controls);
      output.ch(0).at(i).write(r.left); output.ch(1).at(i).write(r.right);
      output.ch(2).at(i).write(r.freezeAmount); output.ch(3).at(i).write(f32(r.frozen));
    }); } };
  });
}
// @ts-expect-error The bounded FDN has no shimmer pitch-shift parameter.
const unsupported: FreezeReverbConfig = { sampleRate: 48000, shimmerSemitones: 12 };
void unsupported;
