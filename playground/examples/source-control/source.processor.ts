import { audioOutput, bool, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { phaseModulation } from '@denaudio/den/source';

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const depth = param.f32({ default: 1.5, min: 0, max: 5, automationRate: 'a-rate' }).named('depthRadians');
  const source = instantiate(phaseModulation, { sampleRate }, { name: 'pm' });
  return { process() { forSample(i => {
    // PM depth is radians. Feedback is the preceding carrier sample.
    const wave = source.tick({ carrierHz: f32(220), modulatorHz: f32(330), depthRadians: depth.at(i),
      feedbackRadians: f32(0.15), reset: bool(false) });
    output.ch(0).at(i).write(wave.mul(0.16));
  }); } };
});
