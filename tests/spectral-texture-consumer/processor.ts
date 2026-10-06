import { audioInput, audioOutput, defineProcessor, forSample, instantiate } from '@unworklet/core';
import { spectralBlur, spectralCrossSynthesis, type SpectralBlurConfig, type SpectralCrossSynthesisConfig } from '@denaudio/den/spectral-texture';

export function makeProcessor(mode: 'blur' | 'cross' = 'blur', size = 256, hopSize = 64) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 4, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
    if (mode === 'blur') {
      const config: SpectralBlurConfig = { size, hopSize, radius: Math.min(8, size / 2 - 1) };
      const unit = instantiate(spectralBlur, config, { name: 'unit' });
      return { process() { forSample((i, every) => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), input.ch(2).at(i), input.ch(3).at(i).gt(0), every))); } };
    }
    const config: SpectralCrossSynthesisConfig = { size, hopSize, maxGain: 16 };
    const unit = instantiate(spectralCrossSynthesis, config, { name: 'unit' });
    return { process() { forSample((i, every) => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), input.ch(1).at(i), input.ch(2).at(i), input.ch(3).at(i).gt(0), every))); } };
  }, { id: `den.spectral.texture.${mode}.n${size}.h${hopSize}` });
}
export default makeProcessor();
