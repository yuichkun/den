import { audioInput, audioOutput, CAPACITY_16, defineProcessor, event, f32, forSample, instantiate } from '@unworklet/core';
import { residentSample, type ResidentSample } from '@denaudio/den/sample';
import { bandedWavetableSource, prepareWavetableBands, type BandedWavetableConfig, type PreparedWavetableBands, type WavetableBandsOptions, type WavetableControls } from '@denaudio/den/wavetable';
export const frameLength = 512, frameCount = 16;
export const frames = Array.from({ length: frameCount }, (_, f) => Float32Array.from({ length: frameLength }, (_, n) => {
  const phase = 2 * Math.PI * n / frameLength;
  return .01 * f + .45 * Math.sin(phase + f / 10) + .2 * Math.cos(3 * phase) + .12 * Math.sin(11 * phase) + .05 * Math.cos(101 * phase);
}));
const options: WavetableBandsOptions = { frames };
export const prepared: PreparedWavetableBands = prepareWavetableBands(options);
export const makeProcessor = () => defineProcessor(ctx => {
  const sample: ResidentSample = instantiate(residentSample, { capacity: 65536, sourceSampleRate: 32000 }, { name: 'asset' });
  const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: 262144 });
  load.onReceive(({ data }) => sample.load(data));
  const config: BandedWavetableConfig = { sampleRate: ctx.sampleRate, sample, frameLength, frameCount, phaseCycles: .975 };
  const table = instantiate(bandedWavetableSource, config, { name: 'table' });
  const input = audioInput({ channels: 3, name: 'controls' }), output = audioOutput({ channels: 2, name: 'main' });
  return { process() { forSample(i => {
    const controls: WavetableControls = { frequencyHz: input.ch(0).at(i), frame: input.ch(1).at(i), reset: input.ch(2).at(i).gt(0) };
    const result = table.tick(controls);
    output.ch(0).at(i).write(result.output); output.ch(1).at(i).write(f32(result.missing));
  }); } };
});
