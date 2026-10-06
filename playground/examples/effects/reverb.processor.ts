import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { algorithmicReverb } from '@denaudio/den/reverb';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 2 });
  const output = audioOutput({ name: 'main', channels: 2 });
  const mix = param.f32({ default: 0.7, min: 0, max: 1, automationRate: 'a-rate' }).named('mix');
  // Room size, nominal loop-loss time and damping are construction-fixed.
  const room = instantiate(algorithmicReverb, {
    sampleRate, roomScale: 0.8, decaySeconds: 1.2, dampingHz: 4200,
  }, { name: 'room' });
  return { process() { forSample(i => {
    const wet = room.tick(input.ch(0).at(i), input.ch(1).at(i), {
      mix: mix.at(i), bypass: bool(false), reset: bool(false),
    });
    output.ch(0).at(i).write(wet.left.mul(0.45));
    output.ch(1).at(i).write(wet.right.mul(0.45));
  }); } };
});
