import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { delayReadhead } from '@denaudio/den/delay-readhead';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const seconds = param.f32({ default: 0.18, min: 0.02, max: 0.5, automationRate: 'a-rate' }).named('seconds');
  const feedback = param.f32({ default: 0.35, min: 0, max: 0.6, automationRate: 'a-rate' }).named('feedback');
  const head = instantiate(delayReadhead, { sampleRate, maxDelaySeconds: 0.5 }, { name: 'head' });
  return { process() { forSample(i => {
    // Read before write: the feedback uses stored history, not the current input.
    const tap = head.read(seconds.at(i), bool(false));
    tap.write(input.ch(0).at(i).add(tap.output.mul(feedback.at(i))));
    output.ch(0).at(i).write(tap.output.mul(0.6));
  }); } };
});
