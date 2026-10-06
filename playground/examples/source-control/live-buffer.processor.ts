import { audioInput, audioOutput, bool, defineProcessor, f64, forSample, instantiate, param } from '@unworklet/core';
import { liveSampleBuffer } from '@denaudio/den/live-buffer';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const age = param.f32({ default: 2400, min: 1, max: 8191, automationRate: 'a-rate' }).named('ageFrames');
  const history = instantiate(liveSampleBuffer, { capacity: 8192, sampleRate }, { name: 'history' });
  return { process() { forSample(i => {
    history.tick({ input: input.ch(0).at(i), record: bool(true), reset: bool(false) });
    // Age zero is the newest accepted write. Read after the current sample's write.
    output.ch(0).at(i).write(history.readAge(f64(age.at(i))).output);
  }); } };
});
