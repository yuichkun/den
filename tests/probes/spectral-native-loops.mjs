// Public-API entry proof for using native fixed loop counters on work buffers.
import assert from 'node:assert/strict';
import { SAMPLES_PER_BLOCK, audioOutput, defineProcessor, f32, forSample, state } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';

assert.equal(SAMPLES_PER_BLOCK, 128);
const processor = defineProcessor(() => {
  const output = audioOutput({ channels: 2, name: 'main' });
  const frame = state.i32(0), sum = state.i32(0), buffer = state.buffer.i32({ size: 4 });
  return { process() { forSample((outer, everyNSamples) => {
    everyNSamples(7, () => {
      sum.write(0);
      forSample.byN(32, inner => {
        const index = inner.div(32);
        buffer.write(index, frame.read().add(index));
        sum.write(sum.read().add(buffer.read(index)));
      });
    });
    output.ch(0).at(outer).write(f32(sum.read()));
    output.ch(1).at(outer).write(f32(outer));
    frame.write(frame.read().add(1));
  }); } };
});
for (const sampleRate of [44100, 48000, 96000]) {
  const result = await renderOffline(processor, { sampleRate, duration: (512 - 0.25) / sampleRate });
  assert.equal(result.diagnostics.scrubbedSamples, 0);
  for (let n = 0; n < 512; n++) {
    assert.equal(result.outputs.main[0][n], 4 * (Math.floor(n / 7) * 7) + 6);
    assert.equal(result.outputs.main[1][n], n % 128);
  }
  console.log(JSON.stringify({ status: 'CANDIDATE', sampleRate, frames: 512, nestedBufferIterations: 4, hop: 7, outerCounterAndBufferOrder: 'pass', scrubbedSamples: 0 }));
}
