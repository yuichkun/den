import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { curveShaper } from '@denaudio/den/curve-shaper';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const gain = param.f32({ default: 8, min: 1, max: 24, automationRate: 'a-rate' }).named('gain');
  const shoulder = param.f32({ default: 0.85, min: 0, max: 1, automationRate: 'a-rate' }).named('shoulder');
  const curve = instantiate(curveShaper, { sampleRate, pointCount: 5, quality: 'adaa' }, { name: 'curve' });
  return { process() { forSample(i => {
    // Five equally spaced input knots: [-1, -0.5, 0, 0.5, 1].
    const y = shoulder.at(i);
    const wet = curve.tick(input.ch(0).at(i), {
      ordinates: [f32(-1), y.mul(-1), f32(0), y, f32(1)],
      gain: gain.at(i), mix: f32(1), reset: bool(false),
    });
    output.ch(0).at(i).write(wet.mul(0.22));
  }); } };
});
