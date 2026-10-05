import { audioInput, audioOutput, defineProcessor, forSample, instantiate } from '@unworklet/core';
import { spectralFreeze, type SpectralFreezeConfig } from '@denaudio/den/spectral-freeze';
export function makeProcessor(config: SpectralFreezeConfig = { size: 1024, hopSize: 512 }) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 3, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
    const freeze = instantiate(spectralFreeze, config, { name: 'freeze' });
    return { process() { forSample((i, everyNSamples) => output.ch(0).at(i).write(freeze.tick(input.ch(0).at(i), input.ch(2).at(i).gt(0), input.ch(1).at(i).gt(0), everyNSamples))); } };
  }, { id: `den.spectral.freeze.consumer.n${config.size}.h${config.hopSize}` });
}
export default makeProcessor();
