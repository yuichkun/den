import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate } from '@unworklet/core';
import { liveSampleBuffer, type LiveSampleBuffer, type LiveSampleBufferStatus } from '@denaudio/den/live-buffer';
import { liveGranularSource, type LiveGranularConfig, type LiveGranularControls, type LiveGranularResult, type LiveGranularSource } from '@denaudio/den/live-granular';
export const capacity = 257, maxGrains = 8;
export const makeProcessor = () => defineProcessor(ctx => {
  const history: LiveSampleBuffer = instantiate(liveSampleBuffer, { capacity, sampleRate: ctx.sampleRate }, { name: 'history' });
  const config: LiveGranularConfig = { history, maxGrains };
  const grains: LiveGranularSource = instantiate(liveGranularSource, config, { name: 'grains' });
  const input = audioInput({ name: 'controls', channels: 7 }), output = audioOutput({ name: 'main', channels: 8 });
  return { process() { forSample(i => {
    const reset = input.ch(2).at(i).gt(0);
    const status: LiveSampleBufferStatus = history.tick({ input: input.ch(0).at(i), record: input.ch(1).at(i).gt(0), reset });
    const controls: LiveGranularControls = { written: status.written, reset, trigger: input.ch(3).at(i).gt(0), ageFrames: input.ch(4).at(i), rate: input.ch(5).at(i), durationSeconds: input.ch(6).at(i) };
    const r: LiveGranularResult = grains.tick(controls);
    [r.output, f32(r.activeGrains), f32(r.launched), f32(r.dropped), f32(r.rejected), f32(r.expiredGrains), f32(status.written), f32(status.length)].forEach((value, ch) => output.ch(ch).at(i).write(value));
  }); } };
});
// This diagnostic actively writes and requests grains on every native sample.
export const makeMemoryProcessor = () => defineProcessor(ctx => {
  const history = instantiate(liveSampleBuffer, { capacity: 65536, sampleRate: ctx.sampleRate }, { name: 'history' });
  const grains = instantiate(liveGranularSource, { history, maxGrains: 8 }, { name: 'grains' });
  const output = audioOutput({ name: 'main', channels: 2 });
  return { process() { forSample(i => {
    const status = history.tick({ input: f32(.25), record: bool(true), reset: bool(false) });
    const r = grains.tick({ written: status.written, reset: bool(false), trigger: bool(true), ageFrames: f32(0), rate: f32(1), durationSeconds: f32(2) });
    output.ch(0).at(i).write(r.output); output.ch(1).at(i).write(f32(r.activeGrains));
  }); } };
});
export default makeProcessor();
