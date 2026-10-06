import { audioInput, audioOutput, defineProcessor, f32, forSample, instantiate } from '@unworklet/core';
import { liveSampleBuffer } from '../../src/live-buffer.js';
import { liveGranularSource } from '../../src/live-granular.js';
export const liveGrainProcessor = (capacity = 257, maxGrains = 8) => defineProcessor(ctx => {
  const history = instantiate(liveSampleBuffer, { capacity, sampleRate: ctx.sampleRate }, { name: 'history' });
  const grains = instantiate(liveGranularSource, { history, maxGrains }, { name: 'grains' });
  const input = audioInput({ name: 'controls', channels: 7 }), output = audioOutput({ name: 'main', channels: 8 });
  return { process() { forSample(i => {
    const reset = input.ch(2).at(i).gt(0);
    const status = history.tick({ input: input.ch(0).at(i), record: input.ch(1).at(i).gt(0), reset });
    const r = grains.tick({ written: status.written, reset, trigger: input.ch(3).at(i).gt(0), ageFrames: input.ch(4).at(i), rate: input.ch(5).at(i), durationSeconds: input.ch(6).at(i) });
    [r.output, f32(r.activeGrains), f32(r.launched), f32(r.dropped), f32(r.rejected), f32(r.expiredGrains), f32(status.written), f32(status.length)].forEach((value, ch) => output.ch(ch).at(i).write(value));
  }); } };
});
