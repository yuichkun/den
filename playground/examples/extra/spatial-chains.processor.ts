import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { feedforwardPitchedReverb } from '@denaudio/den/spatial-chains';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 2 });
  const mix = param.f32({ default: 0.85, min: 0, max: 1, automationRate: 'a-rate' }).named('mix');
  const ratio = param.f32({ default: 2, min: 0.5, max: 2, automationRate: 'a-rate' }).named('ratio');
  const pitchMix = param.f32({ default: 0.5, min: 0, max: 1, automationRate: 'a-rate' }).named('pitchMix');
  // Pitch shifting is feedforward, never fed back through the reverb tank.
  // Try the host's pulsed input to hear the tail between notes.
  const space = instantiate(feedforwardPitchedReverb, {
    sampleRate, windowSamples: 1024,
  }, { name: 'space' });
  return { process() { forSample((i, everyNSamples) => {
    const wet = space.tick(input.ch(0).at(i), {
      mix: mix.at(i), ratio: ratio.at(i), pitchMix: pitchMix.at(i),
      bypass: bool(false), reset: bool(false), retrigger: bool(false),
    }, everyNSamples);
    output.ch(0).at(i).write(wet.left.mul(0.5));
    output.ch(1).at(i).write(wet.right.mul(0.5));
  }); } };
});
