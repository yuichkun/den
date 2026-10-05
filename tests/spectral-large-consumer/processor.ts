import { audioInput, audioOutput, defineProcessor, forSample, instantiate } from '@unworklet/core';
import { stftIdentity } from '@denaudio/den/spectral';

export function makeProcessor(hopSize: number) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 2, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
    const stft = instantiate(stftIdentity, { size: 1024, hopSize }, { name: 'identity' });
    return { process() { forSample((i, everyNSamples) => output.ch(0).at(i).write(stft.tick(input.ch(0).at(i), input.ch(1).at(i).gt(0), everyNSamples))); } };
  }, { id: `den.spectral.large.consumer.h${hopSize}` });
}
export default makeProcessor(512);
