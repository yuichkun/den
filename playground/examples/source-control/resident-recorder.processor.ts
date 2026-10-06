import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate } from '@unworklet/core';
import { residentTakeRecorder } from '@denaudio/den/resident-recorder';
import { samplePlayer } from '@denaudio/den/sample';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  // Capture a short take from the visible native source, then loop that resident take.
  const take = instantiate(residentTakeRecorder, { capacity: 4096, sampleRate }, { name: 'take' });
  const player = instantiate(samplePlayer, { sampleRate, sample: take.sample, loop: true }, { name: 'player' });
  return { process() { forSample(i => {
    const recorded = take.tick({ input: input.ch(0).at(i), record: bool(true), reset: bool(false) });
    // Full takes stop appending. Gate rises only when the complete take is available.
    output.ch(0).at(i).write(player.tick({ gate: recorded.full, trigger: bool(false), reset: bool(false), rate: f32(0.75) }).output);
  }); } };
});
