import { audioInput, audioOutput, CAPACITY_16, defineProcessor, event, f32, f64, forSample, i32, instantiate } from '@unworklet/core';
import { residentTakeRecorder, type ResidentTakeRecorder, type ResidentTakeRecorderControls } from '@denaudio/den/resident-recorder';
import type { ResidentSample } from '@denaudio/den/sample';

export const capacity = 1024;
export const makeProcessor = () => defineProcessor(ctx => {
  const take: ResidentTakeRecorder = instantiate(residentTakeRecorder, { capacity, sampleRate: ctx.sampleRate }, { name: 'take' });
  const sample: ResidentSample = take.sample;
  const input = audioInput({ channels: 4, name: 'controls' }), output = audioOutput({ channels: 7, name: 'main' });
  const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: capacity * 4 });
  load.onReceive(x => sample.load(x.data));
  return { process() { forSample(i => {
    const position = f64(input.ch(3).at(i)), before = sample.read(position, i32(0), i32(capacity), false), beforeLength = sample.length();
    const controls: ResidentTakeRecorderControls = { input: input.ch(0).at(i), record: input.ch(1).at(i).gt(0), reset: input.ch(2).at(i).gt(0) };
    const result = take.tick(controls), after = sample.read(position, i32(0), i32(capacity), false);
    [before, f32(beforeLength), after, f32(result.length), f32(result.written), f32(result.full), f32(sample.revision())].forEach((value, ch) => output.ch(ch).at(i).write(value));
  }); } };
});
export default makeProcessor();
