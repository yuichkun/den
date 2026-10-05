import { defineSubgraph, f32, instantiate, type Node } from '@unworklet/core';
import { stateVariableFilter } from './state-variable-filter.js';
import { checkedSampleRate } from './catalog-filter-math.js';

export interface CrossoverConfig { sampleRate: number }
/** Fourth-order Linkwitz–Riley: cascaded Butterworth LP/HP; positive-polarity sum is allpass. */
export const crossover = defineSubgraph((config: CrossoverConfig) => {
  checkedSampleRate(config.sampleRate);
  const first = instantiate(stateVariableFilter, config, {name:'first'});
  const low = instantiate(stateVariableFilter, config, {name:'low'});
  const high = instantiate(stateVariableFilter, config, {name:'high'});
  return {
    tick(input: Node<'f32'>, cutoffHz: Node<'f32'>, reset: Node<'bool'>) {
      const firstOutput = first.tick(input, cutoffHz, f32(Math.SQRT1_2), reset);
      return {low: low.tick(firstOutput.lowpass, cutoffHz, f32(Math.SQRT1_2), reset).lowpass,
        high: high.tick(firstOutput.highpass, cutoffHz, f32(Math.SQRT1_2), reset).highpass};
    },
  };
});
