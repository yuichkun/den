import { audioInput, audioOutput, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { curveShaper, type CurveShaperQuality, type CurveShaperConfig, type CurveShaperControls } from '@denaudio/den/curve-shaper';
export function makeProcessor(pointCount: number, quality: CurveShaperQuality) {
  return defineProcessor(ctx => {
    const input = audioInput({ name: 'main', channels: 2 });
    const output = audioOutput({ name: 'main', channels: 1 });
    const gain = param.f32({ default: 1, min: 0, max: 32, automationRate: 'a-rate' }).named('gain');
    const mix = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('mix');
    const ordinates = Array.from({ length: pointCount }, (_, j) => param.f32({ default: 2 * j / (pointCount - 1) - 1, min: -1, max: 1, automationRate: 'a-rate' }).named(`ordinate-${j}`));
    const config: CurveShaperConfig = { sampleRate: ctx.sampleRate, pointCount, quality };
    const unit = instantiate(curveShaper, config, { name: 'curve' });
    return { process() { forSample(i => {
      const controls: CurveShaperControls = { gain: gain.at(i), mix: mix.at(i), reset: input.ch(1).at(i).gt(0), ordinates: ordinates.map(p => p.at(i)) };
      output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), controls));
    }); } };
  });
}
// @ts-expect-error No oversampling mode is implied by this first-order LUT.
const unavailableQuality: CurveShaperConfig = { sampleRate: 48000, pointCount: 3, quality: '4x' };
void unavailableQuality;
