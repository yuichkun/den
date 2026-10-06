import { audioInput, audioOutput, bool, defineProcessor, f32, f64, forSample, instantiate } from '@unworklet/core';
import { liveSampleBuffer, type LiveSampleBuffer, type LiveSampleBufferConfig, type LiveSampleBufferControls, type LiveSampleBufferRead, type LiveSampleBufferStatus } from '@denaudio/den/live-buffer';

export const capacity = 257;
export const makeProcessor = () => defineProcessor(ctx => {
  const config: LiveSampleBufferConfig = { capacity, sampleRate: ctx.sampleRate };
  const history: LiveSampleBuffer = instantiate(liveSampleBuffer, config, { name: 'history' });
  const input = audioInput({ channels: 4, name: 'controls' }), output = audioOutput({ channels: 9, name: 'main' });
  return { process() { forSample(i => {
    const age = f64(input.ch(3).at(i)), before: LiveSampleBufferRead = history.readAge(age), beforeLength = history.length();
    const controls: LiveSampleBufferControls = { input: input.ch(0).at(i), record: input.ch(1).at(i).gt(0), reset: input.ch(2).at(i).gt(0) };
    const status: LiveSampleBufferStatus = history.tick(controls), after = history.readAge(age);
    [before.output, f32(before.available), f32(beforeLength), after.output, f32(after.available), f32(status.length), f32(status.written), f32(status.full), f32(history.revision())].forEach((value, ch) => output.ch(ch).at(i).write(value));
  }); } };
});

// This diagnostic really records and wraps, rather than profiling an idle graph.
export const makeMemoryProcessor = () => defineProcessor(ctx => {
  const history = instantiate(liveSampleBuffer, { capacity: 65536, sampleRate: ctx.sampleRate }, { name: 'history' });
  const output = audioOutput({ channels: 1, name: 'main' });
  return { process() { forSample(i => {
    history.tick({ input: f32(.25), record: bool(true), reset: bool(false) });
    output.ch(0).at(i).write(history.readAge(f64(65535)).output);
  }); } };
});
export default makeProcessor();
