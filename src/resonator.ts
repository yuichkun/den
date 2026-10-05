import { defineSubgraph, f32, f64, instantiate, select, state, type Node } from '@unworklet/core';
import { delayReadhead } from './delay-readhead.js';

export interface ResonatorMode { frequencyHz: number; decaySeconds: number; gain: number }
export interface ModalResonatorConfig { sampleRate: number; modes: readonly ResonatorMode[] }

function maximumFrequency(sampleRate: number) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('resonator sampleRate must be in [8000,192000] Hz');
  return 0.45 * sampleRate;
}

/** Fixed stable two-pole modes. Decay is amplitude T60 in seconds. */
export const modalResonator = defineSubgraph((config: ModalResonatorConfig) => {
  const maximum = maximumFrequency(config.sampleRate);
  if (config.modes.length < 1 || config.modes.length > 16) throw new RangeError('modalResonator requires 1–16 modes');
  const scale = 2 ** 128; // Keep valid f32 subnormal tails above upstream scalar-state flush.
  const modes = config.modes.map((mode, i) => {
    if (!Number.isFinite(mode.frequencyHz) || mode.frequencyHz < 20 || mode.frequencyHz > maximum ||
      !Number.isFinite(mode.decaySeconds) || mode.decaySeconds < 0.005 || mode.decaySeconds > 30 ||
      !Number.isFinite(mode.gain) || Math.abs(mode.gain) > 16) throw new RangeError('invalid mode frequency, T60 or gain');
    const omega = 2 * Math.PI * mode.frequencyHz / config.sampleRate;
    const radius = Math.exp(-Math.LN10 * 3 / (mode.decaySeconds * config.sampleRate));
    return { gain: mode.gain, a1: 2 * radius * Math.cos(omega), a2: -radius * radius, b: Math.sin(omega),
      first: state.f64(0).named(`mode${i}First`), second: state.f64(0).named(`mode${i}Second`) };
  });
  const normalization = modes.reduce((sum, mode) => sum + Math.abs(mode.gain), 0) || 1;
  return {
    /** Excitation clamps to [-1,1]. Reset clears each mode before current excitation. */
    tick(input: Node<'f32'>, reset: Node<'bool'>) {
      let sum = f64(0);
      for (const mode of modes) {
        const first = select(reset, f64(0), mode.first.read().div(scale));
        const second = select(reset, f64(0), mode.second.read().div(scale));
        const next = f64(input).clamp(-1, 1).mul(mode.b).add(first.mul(mode.a1)).add(second.mul(mode.a2));
        mode.second.write(first.mul(scale)); mode.first.write(next.mul(scale));
        sum = sum.add(next.mul(mode.gain / normalization));
      }
      return f32(sum);
    },
  };
});

export interface TunedCombConfig { sampleRate: number; minFrequencyHz: number }
export interface TunedCombControls {
  input: Node<'f32'>;
  frequencyHz: Node<'f32'>;
  feedback: Node<'f32'>;
  /** One-pole memory coefficient in [0,1]; 0 bypasses damping, 1 freezes it. */
  damping: Node<'f32'>;
  reset: Node<'bool'>;
}

/** Fractional moving-delay resonator. Interpolation and damping change tuning/decay. */
export const tunedComb = defineSubgraph((config: TunedCombConfig) => {
  const maximum = maximumFrequency(config.sampleRate);
  if (!Number.isFinite(config.minFrequencyHz) || config.minFrequencyHz < 20 || config.minFrequencyHz > maximum) {
    throw new RangeError('comb minFrequencyHz must be in [20,.45*sampleRate]');
  }
  const line = instantiate(delayReadhead, { sampleRate: config.sampleRate, maxDelaySeconds: 1 / config.minFrequencyHz }, { name: 'line' });
  const history = state.f64(0).named('dampingHistory');
  const scale = 2 ** 128;
  return {
    /** Normalize excitation by (1-|feedback|) before storage; return the raw tap. */
    tick(c: TunedCombControls) {
      const frequency = f64(c.frequencyHz).clamp(config.minFrequencyHz, maximum);
      const feedback = f64(c.feedback).clamp(-0.999, 0.999), damping = f64(c.damping).clamp(0, 1);
      const tap = line.read(f32(f64(1).div(frequency)), c.reset);
      const previous = select(c.reset, f64(0), history.read().div(scale));
      const filtered = f64(tap.output).mul(f64(1).sub(damping)).add(previous.mul(damping));
      history.write(filtered.mul(scale));
      tap.write(f32(f64(c.input).mul(f64(1).sub(feedback.abs())).add(filtered.mul(feedback))));
      return tap.output;
    },
  };
});
