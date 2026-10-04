import { audioInput, audioOutput, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
// Physical packed entry until the integration owner adds the proposed public export.
import { delayReadhead } from './node_modules/@denaudio/den/dist/delay-readhead.js';
export const processor = defineProcessor(ctx => {
  const input = audioInput({ channels: 1, name: 'main' });
  const output = audioOutput({ channels: 1, name: 'main' });
  const delay = param.f32({ default: 2.5 / ctx.sampleRate, min: 0, max: 1, automationRate: 'a-rate' }).named('delay');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const cell = instantiate(delayReadhead, { sampleRate: ctx.sampleRate, maxDelaySeconds: 8 }, { name: 'readhead' });
  return { process() { forSample(i => {
    const tap = cell.read(delay.at(i), reset.at(i).gt(0));
    tap.write(input.ch(0).at(i));
    output.ch(0).at(i).write(tap.output);
  }); } };
}, { id: 'den.delay.readhead.consumer.v1' });
