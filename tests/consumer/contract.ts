import { gateCell } from '@denaudio/den';
import { gate } from '@denaudio/den/gate';
import { instantiate, defineProcessor, audioOutput, forSample, f32 } from '@unworklet/core';
export const composed = defineProcessor(() => {
  const cell = instantiate(gateCell, {scale: 0.5}, {name: 'consumer'});
  const output = audioOutput({channels: 1, name: 'main'});
  return {process() { forSample(i => output.ch(0).at(i).write(cell.tick(f32(1), f32(1)))); }};
});
export { gate };
