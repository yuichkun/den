import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { partitionedConvolution } from '@denaudio/den/convolution';

// Fixed 96-frame FIR: three colored reflections, total absolute gain below one.
const impulse = Array.from({ length: 96 }, (_, n) => n === 0 ? 0.6 : n === 31 ? -0.25 : n === 79 ? 0.12 : 0);
export default defineProcessor(() => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const gain = param.f32({ default: 1, min: 0, max: 1.5, automationRate: 'a-rate' }).named('gain');
  // Rebuild to change impulse. This bounded module supports at most 128 taps.
  const convolution = instantiate(partitionedConvolution, { blockSize: 32, impulse }, { name: 'convolution' });
  return { process() { forSample((i, everyNSamples) => {
    output.ch(0).at(i).write(convolution.tick(input.ch(0).at(i), bool(false), everyNSamples).mul(gain.at(i)));
  }); } };
});
