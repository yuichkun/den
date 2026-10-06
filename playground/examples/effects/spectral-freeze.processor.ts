import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param, state } from '@unworklet/core';
import { spectralFreeze } from '@denaudio/den/spectral-freeze';

export default defineProcessor(() => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const freeze = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('freeze');
  const effect = instantiate(spectralFreeze, { size: 256, hopSize: 64 }, { name: 'freeze' });
  const clock = state.i32(0).named('warmup');
  return { process() { forSample((i, everyNSamples) => {
    // Fill history before capturing. Switch freeze to 0 for the live signal,
    // then back to 1 to capture again at the next committed frame boundary.
    const hold = freeze.at(i).gte(0.5).and(clock.read().gte(512));
    clock.write(clock.read().add(1).min(512));
    output.ch(0).at(i).write(effect.tick(input.ch(0).at(i), hold, bool(false), everyNSamples).mul(0.7));
  }); } };
});
