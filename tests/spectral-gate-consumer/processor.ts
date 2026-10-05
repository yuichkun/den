import { audioInput, audioOutput, defineProcessor, forSample, instantiate } from '@unworklet/core';
import { spectralGate, type SpectralGateConfig } from '@denaudio/den/spectral-gate';
export function makeProcessor(config: SpectralGateConfig = { size: 1024, hopSize: 512 }) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 4, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
    const gate = instantiate(spectralGate, config, { name: 'gate' });
    return { process() { forSample((i, everyNSamples) => output.ch(0).at(i).write(gate.tick(input.ch(0).at(i), input.ch(2).at(i), input.ch(3).at(i), input.ch(1).at(i).gt(0), everyNSamples))); } };
  }, { id: `den.spectral.gate.consumer.n${config.size}.h${config.hopSize}` });
}
export default makeProcessor();
