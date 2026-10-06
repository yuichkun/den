import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param, state } from '@unworklet/core';
import { freezeReverb } from '@denaudio/den/freeze-reverb';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 2 });
  const output = audioOutput({ name: 'main', channels: 2 });
  const freeze = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('freeze');
  const room = instantiate(freezeReverb, {
    sampleRate, roomScale: 0.8, decaySeconds: 0.8, transitionSamples: 1024,
  }, { name: 'room' });
  const warmup = Math.round(sampleRate * 0.35);
  const clock = state.i32(0).named('warmup');
  return { process() { forSample(i => {
    // Excite the wet-only network for 350 ms before freezing its stored tail.
    const hold = freeze.at(i).gte(0.5).and(clock.read().gte(warmup));
    clock.write(clock.read().add(1).min(warmup));
    const wet = room.tick(input.ch(0).at(i), input.ch(1).at(i), { freeze: hold, reset: bool(false) });
    output.ch(0).at(i).write(wet.left.mul(0.3));
    output.ch(1).at(i).write(wet.right.mul(0.3));
  }); } };
});
