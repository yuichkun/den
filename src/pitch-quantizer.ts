import { bool, defineSubgraph, f32, f64, i32, select, state, type Node } from '@unworklet/core';

export interface PitchQuantizerConfig {
  /** 1..128 finite offsets in [0,12), in semitones. Copied, f32-rounded, sorted. */
  pitchClasses: readonly number[];
  /** Fixed Schmitt margin in semitones, f32-rounded in [0,12]. Default 0. */
  hysteresis?: number;
}
export interface PitchQuantizerOutput {
  /** Selected octave*12 + pitch class, rounded to f32. */
  pitch: Node<'f32'>;
  /** Index into the sorted, f32-rounded pitchClasses. */
  degree: Node<'i32'>;
  /** Octave multiplier; pitch=12*octave+pitchClasses[degree]. Not an octave label. */
  octave: Node<'i32'>;
}

// Native 0.4.1 scalar state flushes tiny values. f32 controls/offsets scaled
// by this exact power of two remain well above that floor, including 2^-149.
const SCALE = 2 ** 128;

/**
 * Audio-rate, octave-periodic nearest pitch, not audio pitch detection or MIDI
 * output. Call once per sample. NaN becomes 0; other inputs clamp to +/-16384.
 * f64 computational distance ties choose the lower pitch. A positive margin
 * retains the previous degree inside its expanded adjacent-midpoint interval,
 * including both endpoints. Reset (level-sensitive) and first call snap to
 * nearest immediately. Zero margin always uses nearest, including tie policy.
 */
export const pitchQuantizer = defineSubgraph((config: PitchQuantizerConfig) => {
  if (!Array.isArray(config.pitchClasses) || config.pitchClasses.length < 1 || config.pitchClasses.length > 128) {
    throw new RangeError('pitchClasses requires 1..128 offsets');
  }
  // Array.from visits sparse holes too; every supplied slot must be valid.
  const degrees = Array.from(config.pitchClasses, value => {
    if (!Number.isFinite(value) || value < 0 || value >= 12 || Math.fround(value) >= 12) {
      throw new RangeError('pitch class must be finite in [0,12), including after f32 rounding');
    }
    return Math.fround(value) || 0;
  }).sort((a, b) => a - b);
  if (degrees.some((value, n) => n > 0 && value === degrees[n - 1])) {
    throw new RangeError('pitch classes must be distinct after f32 rounding');
  }
  const requestedMargin = config.hysteresis ?? 0;
  if (!Number.isFinite(requestedMargin) || requestedMargin < 0 || requestedMargin > 12) {
    throw new RangeError('hysteresis must be finite in [0,12] semitones');
  }
  const margin = Math.fround(requestedMargin);
  const degree = state.i32(0).named('degree');
  const octave = state.i32(0).named('octave');
  const initialized = state.bool(false).named('initialized');
  const nearestDegree = state.i32(0).named('nearestDegree');
  const nearestOctave = state.i32(0).named('nearestOctave');
  const nearestPitch = state.f64(0).named('nearestPitchScaled');
  const nearestDistance = state.f64(0).named('nearestDistanceScaled');
  const candidateOctave = state.i32(0).named('candidateOctave');
  const candidatePitch = state.f64(0).named('candidatePitchScaled');
  const candidateDistance = state.f64(0).named('candidateDistanceScaled');
  const takeCandidate = state.bool(false).named('takeCandidate');
  const update = state.bool(false).named('update');

  return { tick(input: Node<'f32'>, reset: Node<'bool'>): PitchQuantizerOutput {
    // Unlike min/max alone, the explicit NaN branch gives a portable policy.
    const x = f64(select(input.eq(input), input, f32(0)).clamp(-16384, 16384));
    nearestDistance.write(f64(32768 * SCALE));
    nearestPitch.write(f64(32768 * SCALE));
    for (let n = 0; n < degrees.length; n++) {
      // Compare both bracketing octaves by their actual f64 distances.
      // A midpoint shortcut is not equivalent near zero: e.g. +/-6 have
      // equal rounded distances from an f32 subnormal, so lower must win.
      candidateOctave.write(i32(x.sub(degrees[n]).div(12).floor()));
      for (let adjacent = 0; adjacent < 2; adjacent++) {
        if (adjacent > 0) candidateOctave.write(candidateOctave.read().add(1));
        candidatePitch.write(f64(candidateOctave.read()).mul(12).add(degrees[n]).mul(SCALE));
        candidateDistance.write(x.mul(SCALE).sub(candidatePitch.read()).abs());
        takeCandidate.write(candidateDistance.read().lt(nearestDistance.read()).or(
          candidateDistance.read().eq(nearestDistance.read()).and(candidatePitch.read().lt(nearestPitch.read()))));
        nearestDegree.write(select(takeCandidate.read(), i32(n), nearestDegree.read()));
        nearestOctave.write(select(takeCandidate.read(), candidateOctave.read(), nearestOctave.read()));
        nearestPitch.write(select(takeCandidate.read(), candidatePitch.read(), nearestPitch.read()));
        nearestDistance.write(select(takeCandidate.read(), candidateDistance.read(), nearestDistance.read()));
      }
    }
    if (margin === 0) {
      update.write(bool(true));
    } else {
      let lower = f64(0), upper = f64(0);
      for (let n = 0; n < degrees.length; n++) {
        const previous = n === 0 ? degrees[degrees.length - 1] - 12 : degrees[n - 1];
        const next = n === degrees.length - 1 ? degrees[0] + 12 : degrees[n + 1];
        lower = select(degree.read().eq(n), f64((previous + degrees[n]) / 2 - margin), lower);
        upper = select(degree.read().eq(n), f64((degrees[n] + next) / 2 + margin), upper);
      }
      const base = f64(octave.read()).mul(12);
      update.write(reset.or(initialized.read().not()).or(x.lt(base.add(lower))).or(x.gt(base.add(upper))));
    }
    degree.write(select(update.read(), nearestDegree.read(), degree.read()));
    octave.write(select(update.read(), nearestOctave.read(), octave.read()));
    initialized.write(bool(true));
    let selected = f64(degrees[0]);
    for (let n = 1; n < degrees.length; n++) selected = select(degree.read().eq(n), f64(degrees[n]), selected);
    return { pitch: f32(f64(octave.read()).mul(12).add(selected)), degree: degree.read(), octave: octave.read() };
  } };
});
