import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { pingPongDelay } from '@denaudio/den/stereo-delay';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 2 });
  const time = param.f32({ default: 0.2, min: 0.04, max: 0.5, automationRate: 'a-rate' }).named('time');
  const feedback = param.f32({ default: 0.5, min: 0, max: 0.7, automationRate: 'a-rate' }).named('feedback');
  const delay = instantiate(pingPongDelay, { sampleRate, maxDelaySeconds: 0.5 }, { name: 'pingPong' });
  return { process() { forSample(i => {
    // Excite only the left side; cross-feedback carries repeats to the right.
    const wet = delay.tick(input.ch(0).at(i), f32(0), {
      timeSeconds: time.at(i), feedback: feedback.at(i), mix: f32(0.8),
      bypass: bool(false), reset: bool(false),
    });
    output.ch(0).at(i).write(wet.left.mul(0.6));
    output.ch(1).at(i).write(wet.right.mul(0.6));
  }); } };
});
