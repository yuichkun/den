/** Rejected candidate topology: retained only to prove the automation regression.
 * Moving normalization after the loop exposes its internally amplified history
 * on feedback edits. Never export this as a public resonator implementation.
 */
import { defineSubgraph, f32, f64, instantiate, select, state } from '@unworklet/core';
import { delayReadhead } from '../../src/delay-readhead.js';
import type { TunedCombConfig, TunedCombControls } from '../../src/resonator.js';
export const combWithOutputNormalizationBefore = defineSubgraph((config: TunedCombConfig) => {
  const maximum = 0.45 * config.sampleRate;
  const line = instantiate(delayReadhead, { sampleRate: config.sampleRate, maxDelaySeconds: 1 / config.minFrequencyHz }, { name: 'line' });
  const history = state.f64(0).named('dampingHistory'), scale = 2 ** 128;
  return { tick(c: TunedCombControls) {
    const frequency = f64(c.frequencyHz).clamp(config.minFrequencyHz, maximum);
    const feedback = f64(c.feedback).clamp(-0.999, 0.999), damping = f64(c.damping).clamp(0, 1);
    const tap = line.read(f32(f64(1).div(frequency)), c.reset);
    const previous = select(c.reset, f64(0), history.read().div(scale));
    const filtered = f64(tap.output).mul(f64(1).sub(damping)).add(previous.mul(damping));
    history.write(filtered.mul(scale));
    tap.write(f32(f64(c.input).clamp(-1, 1).add(filtered.mul(feedback))));
    return f32(f64(tap.output).mul(f64(1).sub(feedback.abs())));
  } };
});
