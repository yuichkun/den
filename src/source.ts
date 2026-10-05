import { defineSubgraph, f32, f64, instantiate, select, state, type Node } from '@unworklet/core';
import { oscillator } from './oscillator.js';

export interface SourceConfig { sampleRate: number }
export interface PhaseModulationControls {
  carrierHz: Node<'f32'>;
  modulatorHz: Node<'f32'>;
  /** Signed phase deviation, in radians, clamped to [-8π,8π]. */
  depthRadians: Node<'f32'>;
  /** Previous carrier output (one sample old) times this value, in radians. */
  feedbackRadians: Node<'f32'>;
  reset: Node<'bool'>;
}
export interface FrequencyModulationControls {
  carrierHz: Node<'f32'>;
  modulatorHz: Node<'f32'>;
  /** Signed instantaneous frequency deviation in Hz, not a PM index. */
  deviationHz: Node<'f32'>;
  /** Previous carrier output (one sample old) times this value, in Hz. */
  feedbackHz: Node<'f32'>;
  reset: Node<'bool'>;
}

function maximumFrequency(sampleRate: number) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('source sampleRate must be finite and in [8000,192000] Hz');
  }
  return 0.45 * sampleRate;
}

// Same degree-13 sine construction as oscillator, with a wrapped phase offset.
// Pure graph arithmetic; no runtime JS, table asset, or additional state system.
function sineCycles(cycles: Node<'f64'>) {
  const p = cycles.sub(cycles.floor());
  const folded = select(p.lt(0.25), p, select(p.lt(0.75), f64(0.5).sub(p), p.sub(1)));
  const angle = folded.mul(2 * Math.PI), z = angle.mul(angle);
  const polynomial = f64(1 / 6227020800).mul(z).sub(1 / 39916800).mul(z).add(1 / 362880)
    .mul(z).sub(1 / 5040).mul(z).add(1 / 120).mul(z).sub(1 / 6).mul(z).add(1);
  return f32(angle.mul(polynomial));
}

/** Two-operator PM with a sine modulator and one-sample carrier feedback. */
export const phaseModulation = defineSubgraph((config: SourceConfig) => {
  const maximum = maximumFrequency(config.sampleRate);
  const modulator = instantiate(oscillator, { ...config, waveform: 'sine' }, { name: 'modulator' });
  const phase = state.f64(0).named('carrierPhase');
  const previous = state.f32(0).named('previousCarrier');
  return {
    /** Current phase is emitted before advance. Held reset emits zero every sample. */
    tick(c: PhaseModulationControls) {
      const p = select(c.reset, f64(0), phase.read());
      const prior = select(c.reset, f32(0), previous.read());
      const mod = modulator.tick(c.modulatorHz, c.reset);
      const offset = f64(c.depthRadians).clamp(-8 * Math.PI, 8 * Math.PI).mul(f64(mod))
        .add(f64(c.feedbackRadians).clamp(-Math.PI, Math.PI).mul(f64(prior))).div(2 * Math.PI);
      const output = sineCycles(p.add(offset));
      phase.write(p.add(f64(c.carrierHz).clamp(0, maximum).div(config.sampleRate)).frac());
      previous.write(output);
      return output;
    },
  };
});

/** Two-operator linear FM. Negative instantaneous frequency clips to zero. */
export const frequencyModulation = defineSubgraph((config: SourceConfig) => {
  const maximum = maximumFrequency(config.sampleRate);
  const modulator = instantiate(oscillator, { ...config, waveform: 'sine' }, { name: 'modulator' });
  const phase = state.f64(0).named('carrierPhase');
  const previous = state.f32(0).named('previousCarrier');
  return {
    tick(c: FrequencyModulationControls) {
      const p = select(c.reset, f64(0), phase.read());
      const prior = select(c.reset, f32(0), previous.read());
      const mod = modulator.tick(c.modulatorHz, c.reset);
      const instantaneous = f64(c.carrierHz).clamp(0, maximum)
        .add(f64(c.deviationHz).clamp(-maximum, maximum).mul(f64(mod)))
        .add(f64(c.feedbackHz).clamp(-maximum, maximum).mul(f64(prior))).clamp(0, maximum);
      const output = sineCycles(p);
      phase.write(p.add(instantaneous.div(config.sampleRate)).frac());
      previous.write(output);
      return output;
    },
  };
});

export interface AdditivePartial { ratio: number; gain: number }
export interface AdditiveSourceConfig extends SourceConfig { partials: readonly AdditivePartial[] }

/** Fixed sine partial bank. Gains are normalized by their absolute sum. */
export const additiveSource = defineSubgraph((config: AdditiveSourceConfig) => {
  const maximum = maximumFrequency(config.sampleRate);
  if (config.partials.length < 1 || config.partials.length > 32) throw new RangeError('additiveSource requires 1–32 partials');
  const partials = config.partials.map((p, i) => {
    if (!Number.isFinite(p.ratio) || p.ratio <= 0 || p.ratio > 128 || !Number.isFinite(p.gain) || Math.abs(p.gain) > 16) {
      throw new RangeError('partial ratio must be in (0,128] and gain in [-16,16]');
    }
    return { ...p, source: instantiate(oscillator, { sampleRate: config.sampleRate, waveform: 'sine' }, { name: `partial${i}` }) };
  });
  const normalization = partials.reduce((sum, p) => sum + Math.abs(p.gain), 0) || 1;
  return {
    /** Partials above .45*sampleRate are muted; crossing the limit is not smoothed. */
    tick(frequencyHz: Node<'f32'>, reset: Node<'bool'>) {
      let sum = f64(0);
      for (const p of partials) {
        const frequency = f64(frequencyHz).clamp(0, maximum).mul(p.ratio);
        const sample = p.source.tick(f32(frequency), reset);
        sum = sum.add(f64(select(frequency.lte(maximum), sample, f32(0))).mul(p.gain / normalization));
      }
      return f32(sum);
    },
  };
});

export interface UnisonVoice { detuneCents: number; pan: number }
export interface UnisonSourceConfig extends SourceConfig {
  waveform: 'sine' | 'saw';
  voices: readonly UnisonVoice[];
}

/** Fixed detune bank. Linear pan divided by voice count; L+R is the mono average. */
export const unisonSource = defineSubgraph((config: UnisonSourceConfig) => {
  const maximum = maximumFrequency(config.sampleRate);
  if (config.voices.length < 1 || config.voices.length > 8) throw new RangeError('unisonSource requires 1–8 voices');
  if (config.waveform !== 'sine' && config.waveform !== 'saw') throw new RangeError('unknown unison waveform');
  const voices = config.voices.map((v, i) => {
    if (!Number.isFinite(v.detuneCents) || Math.abs(v.detuneCents) > 1200 || !Number.isFinite(v.pan) || Math.abs(v.pan) > 1) {
      throw new RangeError('unison detune must be in [-1200,1200] cents and pan in [-1,1]');
    }
    return { ratio: 2 ** (v.detuneCents / 1200), left: (1 - v.pan) / (2 * config.voices.length),
      right: (1 + v.pan) / (2 * config.voices.length),
      source: instantiate(oscillator, { sampleRate: config.sampleRate, waveform: config.waveform }, { name: `voice${i}` }) };
  });
  return {
    tick(frequencyHz: Node<'f32'>, reset: Node<'bool'>) {
      let left = f64(0), right = f64(0);
      for (const voice of voices) {
        const frequency = f64(frequencyHz).clamp(0, maximum).mul(voice.ratio).clamp(0, maximum);
        const sample = f64(voice.source.tick(f32(frequency), reset));
        left = left.add(sample.mul(voice.left)); right = right.add(sample.mul(voice.right));
      }
      return { left: f32(left), right: f32(right) };
    },
  };
});
