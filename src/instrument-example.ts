import { defineSubgraph, f32, f64, select, state, type Node } from '@unworklet/core';
import { createInstrument } from './instrument.js';
import type { OscillatorConfig } from './oscillator.js';
import type { FilterConfig } from './filter.js';

/** Replacement demonstration: half-level sine using unworklet's math primitive. */
export const exampleOscillator = defineSubgraph((config: OscillatorConfig) => {
  if (config.waveform !== 'sine') throw new RangeError('exampleOscillator supports sine only');
  const phase = state.f64(0).named('phase');
  return { tick(frequency: Node<'f32'>, reset: Node<'bool'>) {
    const p = select(reset, f64(0), phase.read());
    phase.write(p.add(f64(frequency.clamp(0, 0.45 * config.sampleRate)).div(config.sampleRate)).frac());
    return f32(p.mul(2 * Math.PI).sin()).mul(0.5);
  } };
});

/** Replacement demonstration: one-pole low-pass, intentionally ignores Q. */
export const exampleFilter = defineSubgraph((config: FilterConfig) => {
  const previous = state.f64(0).named('previous');
  return { tick(input: Node<'f32'>, cutoff: Node<'f32'>, _q: Node<'f32'>, reset: Node<'bool'>) {
    // Backward Euler one-pole: alpha = w/(1+w), w=2*pi*fc/fs.
    const w = f64(cutoff.clamp(20, Math.min(20000, 0.45 * config.sampleRate))).mul(2 * Math.PI / config.sampleRate);
    const old = select(reset, f64(0), previous.read());
    const output = old.add(w.div(w.add(1)).mul(f64(input).sub(old)));
    previous.write(output);
    return f32(output);
  } };
});

export const replacementInstrument = createInstrument({
  mode: 'poly', capacity: 4, heldCapacity: 32, waveform: 'sine',
  oscillator: exampleOscillator, filter: exampleFilter,
});
