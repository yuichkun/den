import { defineSubgraph, f32, f64, i32, instantiate, select, state, type Node } from '@unworklet/core';

export type DetectorMode = 'peak' | 'rms';
export interface EnvelopeFollowerConfig { sampleRate: number; mode: DetectorMode }
export interface EnvelopeFollowerControls {
  /** Seconds: zero is immediate; positive values use at least one sample, at most 30 s. */
  attack: Node<'f32'>;
  release: Node<'f32'>;
  reset: Node<'bool'>;
}
export interface DynamicsGainControls {
  /** dBFS, clamped to [-120, 24]. */
  thresholdDb: Node<'f32'>;
  /** Input/output slope ratio, clamped to [1, 100]. */
  ratio: Node<'f32'>;
  /** Full knee width in dB, clamped to [0, 48]. Zero is a hard knee. */
  kneeDb: Node<'f32'>;
  /** Maximum attenuation in dB, clamped to [0, 120]. */
  rangeDb: Node<'f32'>;
}
export type DynamicsMode = 'compressor' | 'expander' | 'gate' | 'duck';
export interface DynamicsConfig extends EnvelopeFollowerConfig {
  /** Feedforward, linked stereo, no lookahead. */
  operation: DynamicsMode;
  /** Gate/duck close below threshold minus this amount; fixed at construction. */
  hysteresisDb?: number;
}
export interface DynamicsControls extends DynamicsGainControls {
  detectorAttack: Node<'f32'>;
  detectorRelease: Node<'f32'>;
  /** Gain ballistics in seconds, separate from detector ballistics. */
  attack: Node<'f32'>;
  release: Node<'f32'>;
  reset: Node<'bool'>;
}

function validate(config: EnvelopeFollowerConfig) {
  if (!Number.isInteger(config.sampleRate) || config.sampleRate < 8000 || config.sampleRate > 192000) {
    throw new RangeError('dynamics sampleRate must be an integer in [8000, 192000] Hz');
  }
  if (config.mode !== 'peak' && config.mode !== 'rms') throw new RangeError('dynamics mode must be peak or rms');
}

// Reject only nonfinite values. Valid f32 audio, including subnormals and values
// beyond full scale, is neither clipped nor silently replaced by zero.
function finite(input: Node<'f32'>, fallback = 0) {
  return select(input.eq(input).and(input.abs().lte(3.4028234663852886e38)), input, f32(fallback));
}
function bounded(input: Node<'f32'>, low: number, high: number, fallback: number) {
  return finite(input, fallback).clamp(low, high);
}

// 0.4.1 scalar state writes flush magnitudes below 1e-30. Keeping the
// nonnegative history scaled preserves even squared f32 subnormal amplitudes.
// The exact power-of-two scale avoids rounding during scale/unscale; the
// largest scaled f32 power is <2**512, safely inside binary64 range.
const HISTORY_SCALE = 2 ** 256;
function smoother(sampleRate: number, name: string) {
  const history = state.f64(0).named(`${name}Scaled`);
  const exponent = state.f64(0).named(`${name}Exponent`);
  return (target: Node<'f64'>, rise: Node<'f32'>, fall: Node<'f32'>, reset: Node<'bool'>) => {
    const previous = select(reset, f64(0), history.read().div(HISTORY_SCALE));
    const seconds = select(target.gt(previous), bounded(rise, 0, 30, 0), bounded(fall, 0, 30, 0));
    exponent.write(f64(1).div(f64(seconds).mul(sampleRate).max(1)));
    const x = exponent.read();
    // 1-exp(-x), 0 < x <= 1. Degree 13, absolute remainder <=1/14!.
    // Unlike 1-f32(exp(-x)), it retains accurate long time constants.
    const polynomial = f64(1 / 6227020800).mul(x).sub(1 / 479001600)
      .mul(x).add(1 / 39916800).mul(x).sub(1 / 3628800)
      .mul(x).add(1 / 362880).mul(x).sub(1 / 40320)
      .mul(x).add(1 / 5040).mul(x).sub(1 / 720)
      .mul(x).add(1 / 120).mul(x).sub(1 / 24)
      .mul(x).add(1 / 6).mul(x).sub(1 / 2).mul(x).add(1);
    const coefficient = select(seconds.eq(0), f64(1), x.mul(polynomial));
    const next = previous.mul(f64(1).sub(coefficient)).add(target.mul(coefficient));
    history.write(next.mul(HISTORY_SCALE));
    return history.read().div(HISTORY_SCALE);
  };
}

/** Rectified-amplitude peak or exponentially averaged power RMS follower. */
export const envelopeFollower = defineSubgraph((config: EnvelopeFollowerConfig) => {
  validate(config);
  const smooth = smoother(config.sampleRate, 'detector');
  return {
    /** Once per sample. Reset clears history before processing the current input. */
    tick(input: Node<'f32'>, controls: EnvelopeFollowerControls) {
      const amplitude = f64(finite(input)).abs();
      const target = config.mode === 'rms' ? amplitude.mul(amplitude) : amplitude;
      const level = smooth(target, controls.attack, controls.release, controls.reset);
      return f32(config.mode === 'rms' ? level.max(0).sqrt() : level);
    },
  };
});

/** Feedforward downward-compression static gain in dB (never positive). */
export function compressorGainDb(levelDb: Node<'f32'>, controls: DynamicsGainControls) {
  const delta = f64(bounded(levelDb, -900, 900, -900)).sub(f64(bounded(controls.thresholdDb, -120, 24, 0)));
  const width = f64(bounded(controls.kneeDb, 0, 48, 0));
  const slope = f64(1).sub(f64(1).div(f64(bounded(controls.ratio, 1, 100, 1))));
  const curved = delta.add(width.mul(0.5)).max(0);
  const reduction = select(delta.gte(width.mul(0.5)), delta.max(0).mul(slope),
    curved.mul(curved).mul(slope).div(select(width.gt(0), width, f64(1)).mul(2)));
  return f32(reduction.min(f64(bounded(controls.rangeDb, 0, 120, 120))).neg());
}

/** Downward-expansion static gain in dB; ratio is the below-threshold slope. */
export function expanderGainDb(levelDb: Node<'f32'>, controls: DynamicsGainControls) {
  const below = f64(bounded(controls.thresholdDb, -120, 24, 0)).sub(f64(bounded(levelDb, -900, 900, -900)));
  const width = f64(bounded(controls.kneeDb, 0, 48, 0));
  const slope = f64(bounded(controls.ratio, 1, 100, 1)).sub(1);
  const curved = below.add(width.mul(0.5)).max(0);
  const reduction = select(below.gte(width.mul(0.5)), below.max(0).mul(slope),
    curved.mul(curved).mul(slope).div(select(width.gt(0), width, f64(1)).mul(2)));
  return f32(reduction.min(f64(bounded(controls.rangeDb, 0, 120, 120))).neg());
}

/**
 * Single-band feedforward dynamics with max-absolute stereo sidechain linking.
 * Pass the program L/R as sidechain L/R for internal detection, or supply a key.
 * Gate/duck are hysteretic keyed switches with smoothed attenuation; ratio and
 * knee affect only compressor/expander. There is no makeup gain or limiter.
 */
export const dynamics = defineSubgraph((config: DynamicsConfig) => {
  validate(config);
  if (!['compressor', 'expander', 'gate', 'duck'].includes(config.operation)) throw new RangeError('invalid dynamics operation');
  const hysteresis = config.hysteresisDb ?? 3;
  if (!Number.isFinite(hysteresis) || hysteresis < 0 || hysteresis > 24) throw new RangeError('dynamics hysteresisDb must be in [0, 24]');
  const detector = instantiate(envelopeFollower, { sampleRate: config.sampleRate, mode: config.mode }, { name: 'sidechain' });
  const active = state.i32(0).named('keyActive');
  const levelDb = state.f64(0).named('levelDb');
  const gain = state.f64(1).named('gain');
  const smooth = smoother(config.sampleRate, 'attenuation');
  return {
    tick(left: Node<'f32'>, right: Node<'f32'>, sidechainLeft: Node<'f32'>, sidechainRight: Node<'f32'>, controls: DynamicsControls) {
      const key = finite(sidechainLeft).abs().max(finite(sidechainRight).abs());
      const envelope = detector.tick(key, { attack: controls.detectorAttack, release: controls.detectorRelease, reset: controls.reset });
      // Floor applies only to the gain-law meter, never the follower or audio.
      // 1e-30 gives -600 dB; all thresholds are >=-120 dB.
      levelDb.write(f64(envelope.max(1e-30).log()).mul(20 / Math.LN10));
      const level = f32(levelDb.read());
      let target: Node<'f64'>;
      if (config.operation === 'compressor') target = f64(compressorGainDb(level, controls)).neg();
      else if (config.operation === 'expander') target = f64(expanderGainDb(level, controls)).neg();
      else {
        const threshold = bounded(controls.thresholdDb, -120, 24, 0);
        const wasActive = active.read().gt(0).and(controls.reset.not());
        const isActive = level.gte(threshold).or(wasActive.and(level.gt(threshold.sub(hysteresis))));
        active.write(select(isActive, i32(1), i32(0)));
        const attenuate = config.operation === 'duck' ? isActive : isActive.not();
        target = f64(select(attenuate, bounded(controls.rangeDb, 0, 120, 120), f32(0)));
      }
      // Gate/expander attack opens the gain, release closes it. Compressor/duck
      // attack increases attenuation, release returns towards unity.
      const opens = config.operation === 'gate' || config.operation === 'expander';
      const reduction = smooth(target, opens ? controls.release : controls.attack, opens ? controls.attack : controls.release, controls.reset);
      gain.write(f64(f32(reduction.neg().mul(Math.LN10 / 20)).exp()).clamp(0, 1));
      const linear = gain.read();
      return {
        left: f32(f64(finite(left)).mul(linear)),
        right: f32(f64(finite(right)).mul(linear)),
        envelope,
        gain: f32(linear),
        gainDb: f32(reduction.neg()),
      };
    },
  };
});
