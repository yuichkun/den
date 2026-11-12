import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param, select, state } from '@unworklet/core';
import { spectralFreeze } from '@denaudio/den/spectral-freeze';

export default defineProcessor(({ renderQuantumSize }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const freeze = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('freeze');
  const effect = instantiate(spectralFreeze, { renderQuantumSize, size: 256, hopSize: 64 }, { name: 'freeze' });
  const clock = state.i32(0).named('warmup');
  return { process() { forSample((i, everyNSamples) => {
    const sample = input.ch(0).at(i);
    // The host may connect its source after processing starts. Wait for its
    // first nonzero sample, then fill history before the initial capture.
    // Switch freeze to 0 for live input, then to 1 to capture again.
    const hold = freeze.at(i).gte(0.5).and(clock.read().gte(512));
    clock.write(select(clock.read().gt(0).or(sample.eq(0).not()), clock.read().add(1).min(512), clock.read()));
    output.ch(0).at(i).write(effect.tick(sample, hold, bool(false), everyNSamples).mul(0.7));
  }); } };
});
