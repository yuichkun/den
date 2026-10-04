import { defineSubgraph, state, type Node } from '@unworklet/core';

/** Minimal composition fixture, not a production DSP module. Required config avoids upstream #104. */
export const gateCell = defineSubgraph((config: { scale: number }) => {
  const previous = state.f32(0).named('previous');
  return {
    tick(input: Node<'f32'>, gain: Node<'f32'>) {
      const output = previous.read().mul(gain).mul(config.scale);
      previous.write(input);
      return output;
    },
  };
});
