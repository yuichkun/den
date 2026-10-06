import { audioInput, audioOutput, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { gateCell } from '@denaudio/den';

export default defineProcessor(() => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const gain = param.f32({ default: 0.5, min: 0, max: 1, automationRate: 'a-rate' }).named('gain');
  // The package root is a one-sample memory/gain composition fixture.
  const cell = instantiate(gateCell, { scale: 1 }, { name: 'cell' });
  return { process() { forSample(i => {
    output.ch(0).at(i).write(cell.tick(input.ch(0).at(i), gain.at(i)));
  }); } };
});
