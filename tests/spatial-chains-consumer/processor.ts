import { audioInput, audioOutput, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import {
  hybridReverb, feedforwardPitchedReverb,
  type SpatialChainConfig, type SpatialChainControls,
  type FeedforwardPitchedReverbConfig, type FeedforwardPitchedReverbControls,
} from '@denaudio/den/spatial-chains';

export function makeProcessor(mode: 'hybrid' | 'pitched' = 'hybrid', windowSamples = 2048) {
  return defineProcessor(({ sampleRate }) => {
    const input = audioInput({ name: 'main', channels: 4 }), output = audioOutput({ name: 'main', channels: 3 });
    const mix = param.f32({ default: .5, min: 0, max: 1, automationRate: 'a-rate' }).named('mix');
    const ratio = param.f32({ default: 2, min: .5, max: 2, automationRate: 'a-rate' }).named('ratio');
    const pitchMix = param.f32({ default: .5, min: 0, max: 1, automationRate: 'a-rate' }).named('pitchMix');
    const config: SpatialChainConfig = { sampleRate };
    const pitchedConfig: FeedforwardPitchedReverbConfig = { ...config, windowSamples };
    const plain = mode === 'hybrid' ? instantiate(hybridReverb, config, { name: 'space' }) : undefined;
    const pitched = mode === 'pitched' ? instantiate(feedforwardPitchedReverb, pitchedConfig, { name: 'space' }) : undefined;
    return { process() { forSample((i, everyNSamples) => {
      const controls: SpatialChainControls = { mix: mix.at(i), bypass: input.ch(1).at(i).gt(0), reset: input.ch(2).at(i).gt(0) };
      if (plain) {
        const value = plain.tick(input.ch(0).at(i), controls, everyNSamples);
        output.ch(0).at(i).write(value.left); output.ch(1).at(i).write(value.right); output.ch(2).at(i).write(f32(0));
      } else if (pitched) {
        const controlsWithPitch: FeedforwardPitchedReverbControls = { ...controls, ratio: ratio.at(i), pitchMix: pitchMix.at(i), retrigger: input.ch(3).at(i).gt(0) };
        const value = pitched.tick(input.ch(0).at(i), controlsWithPitch, everyNSamples);
        output.ch(0).at(i).write(value.left); output.ch(1).at(i).write(value.right); output.ch(2).at(i).write(f32(value.ratioRejected));
      }
    }); } };
  }, { id: `den.spatial.${mode}.w${windowSamples}` });
}
export default makeProcessor();
