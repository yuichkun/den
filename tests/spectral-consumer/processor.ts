import { audioInput, audioOutput, defineProcessor, forSample, instantiate } from '@unworklet/core';
import { stftIdentity } from '@denaudio/den/spectral';
import { partitionedConvolution } from '@denaudio/den/convolution';

export const impulse = Array.from({ length: 79 }, (_, n) => n === 0 ? 0.5 : n === 31 ? -0.25 : n === 32 ? 0.75 : n === 63 ? 0.5 : n === 64 ? -0.5 : n === 78 ? 0.25 : 0);
export const processor = defineProcessor(() => {
  const input = audioInput({ channels: 2, name: 'main' }), output = audioOutput({ channels: 2, name: 'main' });
  const stft = instantiate(stftIdentity, { size: 64, hopSize: 16 }, { name: 'identity' });
  const convolution = instantiate(partitionedConvolution, { blockSize: 32, impulse }, { name: 'convolution' });
  return { process() { forSample((i, everyNSamples) => {
    const signal = input.ch(0).at(i), reset = input.ch(1).at(i).gt(0);
    output.ch(0).at(i).write(stft.tick(signal, reset, everyNSamples));
    output.ch(1).at(i).write(convolution.tick(signal, reset, everyNSamples));
  }); } };
});
export default processor;
