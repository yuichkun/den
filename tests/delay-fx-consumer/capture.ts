import { audioInput, audioOutput, defineProcessor, forSample, f32, state } from '@unworklet/core';

// Test apparatus only: capture downstream graph samples on the audio thread.
// Existing unworklet buffers/snapshots avoid ScriptProcessor's main-thread delivery.
export const capture = defineProcessor(() => {
  const input = audioInput({ name: 'main', channels: 3 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const frames = state.i32(0).named('frames');
  // Extra guard quantum keeps the requested prefix immutable after it is full.
  const recordings = ['input', 'left', 'right'].map(name => state.buffer.f32({ size: 2 ** 19 + 128 })
    .expose({ name, snapshot: 'persistent' }));
  return { process() { forSample(i => {
    const index = frames.read().clamp(0, 2 ** 19 + 127);
    recordings.forEach((recording, ch) => recording.write(index, input.ch(ch).at(i)));
    frames.write(frames.read().add(1));
    output.ch(0).at(i).write(f32(0));
  }); } };
}, { id: 'den.delay.fx.capture.v1' });
