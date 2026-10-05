import { audioInput, audioOutput, CAPACITY_16, defineProcessor, event, f32, forSample, instantiate, param } from '@unworklet/core';
import { residentSample } from '@denaudio/den/sample';
import { residentTimeStretch, type ResidentTimeStretchConfig, type ResidentTimeStretchControls } from '@denaudio/den/resident-time-stretch';
export function makeProcessor(sourceRate: number, capacity = 65536, hopSamples: 128 | 256 = 256, searchFrames: ResidentTimeStretchConfig['searchFrames'] = 64) {
  return defineProcessor(ctx => {
    const sample = instantiate(residentSample, { capacity, sourceSampleRate: sourceRate }, { name: 'sample' });
    const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: capacity * 4 }); load.onReceive(x => sample.load(x.data));
    const unit = instantiate(residentTimeStretch, { sampleRate: ctx.sampleRate, sample, hopSamples, searchFrames }, { name: 'stretch' });
    const input = audioInput({ name: 'controls', channels: 3 }), output = audioOutput({ name: 'main', channels: 8 });
    const durationScale = param.f32({ default: 1, min: .5, max: 2, automationRate: 'a-rate' }).named('durationScale');
    const pitchRatio = param.f32({ default: 1, min: .5, max: 2, automationRate: 'a-rate' }).named('pitchRatio');
    return { process() { forSample((i, everyNSamples) => {
      const controls: ResidentTimeStretchControls = { gate: input.ch(0).at(i).gt(0), trigger: input.ch(1).at(i).gt(0), reset: input.ch(2).at(i).gt(0), durationScale: durationScale.at(i), pitchRatio: pitchRatio.at(i) };
      const result = unit.tick(controls, everyNSamples);
      [result.output, f32(result.active), result.position, f32(result.ended), f32(result.pending), f32(result.rejected), f32(result.missing), f32(result.selectedOffset)].forEach((x, j) => output.ch(j).at(i).write(x));
    }); } };
  });
}
// @ts-expect-error Grain hop is construction-fixed and deliberately bounded.
const invalid: ResidentTimeStretchConfig['hopSamples'] = 1024;
void invalid;
