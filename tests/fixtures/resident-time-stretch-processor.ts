import { audioInput, audioOutput, CAPACITY_16, defineProcessor, event, f32, forSample, instantiate } from '@unworklet/core';
import { residentSample } from '../../src/sample.js';
import { residentTimeStretch, type ResidentTimeStretchConfig } from '../../src/resident-time-stretch.js';
export function stretchProcessor(sourceRate: number, capacity = 65536, hopSamples: 128 | 256 = 256, searchFrames: ResidentTimeStretchConfig['searchFrames'] = 64) {
  return defineProcessor(ctx => {
    const sample = instantiate(residentSample, { capacity, sourceSampleRate: sourceRate }, { name: 'sample' });
    const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: capacity * 4 }); load.onReceive(x => sample.load(x.data));
    const unit = instantiate(residentTimeStretch, { sampleRate: ctx.sampleRate, sample, hopSamples, searchFrames }, { name: 'stretch' });
    const input = audioInput({ name: 'controls', channels: 5 }), output = audioOutput({ name: 'main', channels: 8 });
    return { process() { forSample((i, everyNSamples) => {
      const result = unit.tick({ gate: input.ch(0).at(i).gt(0), trigger: input.ch(1).at(i).gt(0), reset: input.ch(2).at(i).gt(0), durationScale: input.ch(3).at(i), pitchRatio: input.ch(4).at(i) }, everyNSamples);
      [result.output, f32(result.active), result.position, f32(result.ended), f32(result.pending), f32(result.rejected), f32(result.missing), f32(result.selectedOffset)].forEach((x, j) => output.ch(j).at(i).write(x));
    }); } };
  });
}
