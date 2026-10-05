import { defineSubgraph, f32, f64, instantiate, select, state, type Node } from '@unworklet/core';
import { crossover } from './crossover.js';
import { dynamics, type DynamicsConfig, type DynamicsControls } from './dynamics.js';

export type MultibandDynamicsBandConfig = Omit<DynamicsConfig, 'sampleRate'>;
export interface MultibandDynamicsConfig {
  sampleRate: number;
  /** Fixed low/mid/high operations and detector modes. */
  bands: readonly [MultibandDynamicsBandConfig, MultibandDynamicsBandConfig, MultibandDynamicsBandConfig];
}
export type MultibandDynamicsBandControls = Omit<DynamicsControls, 'reset'>;
export interface MultibandDynamicsControls {
  /** Finite fallbacks 200/2000 Hz, individually clamped and then sorted. Equality is permitted. */
  lowCutoffHz: Node<'f32'>;
  highCutoffHz: Node<'f32'>;
  bands: readonly [MultibandDynamicsBandControls, MultibandDynamicsBandControls, MultibandDynamicsBandControls];
  reset: Node<'bool'>;
}
function finite(input: Node<'f32'>, fallback = 0) {
  return select(input.eq(input).and(input.abs().lte(3.4028234663852886e38)), input, f32(fallback));
}
const sum = (a: Node<'f32'>, b: Node<'f32'>, c?: Node<'f32'>) => f32(f64(a).add(f64(b)).add(c ? f64(c) : f64(0)));

/** Three phase-compensated LR4 bands with independent linked-stereo dynamics. */
export const multibandDynamics = defineSubgraph((config: MultibandDynamicsConfig) => {
  const { sampleRate } = config;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('multibandDynamics sampleRate must be an integer in [8000,192000]');
  }
  if (!Array.isArray(config.bands) || config.bands.length !== 3) throw new RangeError('multibandDynamics requires exactly three bands');
  const maximum = Math.min(20000, 0.45 * sampleRate);
  const splits = ['left', 'right'].map(channel => ({
    low: instantiate(crossover, { sampleRate }, { name: `${channel}LowSplit` }),
    high: instantiate(crossover, { sampleRate }, { name: `${channel}HighSplit` }),
    compensate: instantiate(crossover, { sampleRate }, { name: `${channel}LowCompensation` }),
  }));
  // Materialize the existing f32 stage boundaries once. Without these native
  // scratch buffers, 0.4.1 re-expands returned expressions at every consumer.
  // Exact binary64 scaling prevents the native <1e-30 buffer-store flush from
  // changing tiny audio; each slot is overwritten before read on every tick.
  const scale = 2 ** 128;
  const scratch = ['left', 'right'].map(channel => state.buffer.f64({ size: 5 })
    .expose({ name: `${channel}StageScratchScaled`, snapshot: 'transient' }));
  const processors = config.bands.map((band, i) => instantiate(dynamics, { ...band, sampleRate }, { name: `band${i}` }));
  return {
    /** No explicit sample delay. IIR phase/group delay is frequency dependent. */
    tick(left: Node<'f32'>, right: Node<'f32'>, controls: MultibandDynamicsControls) {
      const a = finite(controls.lowCutoffHz, 200).clamp(20, maximum);
      const b = finite(controls.highCutoffHz, 2000).clamp(20, maximum);
      const lowCutoffHz = a.min(b), highCutoffHz = a.max(b);
      const bands = [left, right].map((input, ch) => {
        const first = splits[ch].low.tick(finite(input), lowCutoffHz, controls.reset);
        const store = (index: number, value: Node<'f32'>) => scratch[ch].write(index, f64(value).mul(scale));
        const read = (index: number) => f32(scratch[ch].read(index).div(scale));
        store(0, first.low); store(1, first.high);
        const upper = splits[ch].high.tick(read(1), highCutoffHz, controls.reset);
        const compensation = splits[ch].compensate.tick(read(0), highCutoffHz, controls.reset);
        store(2, sum(compensation.low, compensation.high)); store(3, upper.low); store(4, upper.high);
        return [read(2), read(3), read(4)] as const;
      });
      const processed = processors.map((unit, i) => unit.tick(bands[0][i], bands[1][i], bands[0][i], bands[1][i], { ...controls.bands[i], reset: controls.reset }));
      return {
        left: sum(processed[0].left, processed[1].left, processed[2].left),
        right: sum(processed[0].right, processed[1].right, processed[2].right),
        /** Phase-matched unprocessed recombination; not the original dry PCM. */
        dryLeft: sum(...bands[0]), dryRight: sum(...bands[1]),
        low: processed[0], mid: processed[1], high: processed[2],
        lowCutoffHz, highCutoffHz,
      };
    },
  };
});
