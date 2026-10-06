import { defineSubgraph, f64, i32, instantiate, select, state, type EveryNSamples, type Node } from '@unworklet/core';
import { spectralForEach } from './spectral-fft.js';
import { createStftIdentity } from './spectral-stft.js';

export interface SpectralBlurConfig {
  /** Construction-fixed power of two in [8,256]; live reference delay is size. */
  size: number;
  /** Exactly size/2 or size/4. */
  hopSize: number;
  /** Circular triangular magnitude kernel radius, integer [1,min(8,size/2-1)]. */
  radius: number;
}

export interface SpectralCrossSynthesisConfig {
  /** Construction-fixed power of two in [8,256]; live reference delay is size. */
  size: number;
  /** Exactly size/2 or size/4. */
  hopSize: number;
  /** Maximum per-bin carrier gain; finite construction constant in [1,16]. */
  maxGain: number;
}

const scale = 2 ** 128;
const phaseFloor = 2 ** -20;
const boundedAmount = (amount: Node<'f32'>) => select(amount.eq(amount), f64(amount).max(0).min(1), f64(0)).mul(scale);

/** Frequency-magnitude blur, periodic sqrt-Hann WOLA. Offline CANDIDATE.
 * Call once per sample in stride-1 forSample with its everyNSamples.
 * Finite normalized f32 input [-1,1]. Amount clamps [0,1], NaN=>0.
 * Amount is frame-sampled and interpolates raw two-sided magnitudes linearly.
 * Bins >=2^-20 of the frame peak retain current phase; weaker/zero bins use
 * phase zero. This can jump at the floor and is not a phase-vocoder/smoothing.
 * Amount=0 uses the untouched spectrum; previous processed overlap must settle.
 * Reset immediately silences/discards input, without rephasing. Drain 2N zeros.
 * Peaks can grow; no limiter, sound approval, browser or realtime guarantee.
 */
export const spectralBlur = defineSubgraph((config: SpectralBlurConfig) => {
  const { size, radius } = config, half = size / 2;
  if (!Number.isInteger(radius) || radius < 1 || radius > Math.min(8, half - 1)) {
    throw new RangeError('spectralBlur radius must be an integer in [1,min(8,size/2-1)]');
  }
  const framing = createStftIdentity(config, 256, spectrum => {
    peak.write(0);
    const storeMagnitude = (k: Node<'i32'>) => {
      const re = spectrum.real(k), im = select(k.eq(0).or(k.eq(half)), f64(0), spectrum.imag(k));
      const magnitude = re.mul(re).add(im.mul(im)).sqrt();
      magnitudes.write(k, magnitude); peak.write(peak.read().max(magnitude));
    };
    spectralForEach(half, storeMagnitude); storeMagnitude(i32(half));
    const canonical = (index: Node<'i32'>) => index.min(i32(size).sub(index));
    const processBin = (k: Node<'i32'>) => {
      let blurred = f64(0);
      for (let j = -radius; j <= radius; j++) {
        const at = canonical(k.add(size + j).mod(size));
        blurred = blurred.add(magnitudes.read(at).mul((radius + 1 - Math.abs(j)) / (radius + 1) ** 2));
      }
      const magnitude = magnitudes.read(k), mix = amount.read().div(scale);
      const target = magnitude.mul(f64(1).sub(mix)).add(blurred.mul(mix));
      const retained = magnitude.gt(0).and(magnitude.gte(peak.read().mul(phaseFloor)));
      // select evaluates both branches: sanitize the divisor even for zero bins.
      const denominator = select(magnitude.gt(0), magnitude, f64(1));
      real.write(k, select(retained, spectrum.real(k).div(denominator), f64(1)).mul(target));
      const imaginary = select(k.eq(0).or(k.eq(half)), f64(0), spectrum.imag(k));
      imag.write(k, select(retained, imaginary.div(denominator), f64(0)).mul(target));
    };
    spectralForEach(half, processBin); processBin(i32(half));
    return {
      real(k: number | Node<'i32'>) {
        const index = typeof k === 'number' ? i32(k) : k;
        return select(amount.read().eq(0), spectrum.real(index), real.read(canonical(index)));
      },
      imag(k: number | Node<'i32'>) {
        const index = typeof k === 'number' ? i32(k) : k;
        const value = imag.read(canonical(index));
        return select(amount.read().eq(0), spectrum.imag(index), select(index.gt(half), value.neg(), value));
      },
    };
  });
  const amount = state.f64(0).expose({ name: 'amountScaled', snapshot: 'transient' });
  const peak = state.f64(0).expose({ name: 'peakScaled', snapshot: 'transient' });
  const magnitudes = state.buffer.f64({ size: half + 1 }).expose({ name: 'magnitudesScaled', snapshot: 'transient' });
  const real = state.buffer.f64({ size: half + 1 }).expose({ name: 'blurRealScaled', snapshot: 'transient' });
  const imag = state.buffer.f64({ size: half + 1 }).expose({ name: 'blurImagScaled', snapshot: 'transient' });
  return {
    tick(input: Node<'f32'>, blend: Node<'f32'>, reset: Node<'bool'>, everyNSamples: EveryNSamples): Node<'f32'> {
      amount.write(boundedAmount(blend));
      return framing.tick(input, reset, everyNSamples);
    },
  };
});

// A private, separately named native STFT instance preserves all frame statements
// and tap writes even though its synthesized audio output is unused by the caller.
const magnitudeTap = defineSubgraph((config: { size: number; hopSize: number }) => {
  const { size } = config, half = size / 2;
  const framing = createStftIdentity(config, 256, spectrum => {
    const capture = (k: Node<'i32'>) => {
      const re = spectrum.real(k), im = select(k.eq(0).or(k.eq(half)), f64(0), spectrum.imag(k));
      magnitudes.write(k, re.mul(re).add(im.mul(im)).sqrt());
    };
    spectralForEach(half, capture); capture(i32(half));
    return spectrum;
  });
  const magnitudes = state.buffer.f64({ size: half + 1 }).expose({ name: 'magnitudesScaled', snapshot: 'transient' });
  return {
    tick: framing.tick,
    magnitude(k: Node<'i32'>) { return magnitudes.read(k); },
  };
});

/** Gain-bounded carrier-phase magnitude replacement. Offline CANDIDATE.
 * Same call/framing/input/reset/amount/drain contract as spectralBlur.
 * Amount=1 targets modulator magnitudes, capped at maxGain*carrier magnitude.
 * Zero carrier stays silent; near-zero carrier gain is bounded by maxGain.
 * Zero modulator at amount=1 suppresses all newly committed carrier bins.
 * The modulator and carrier are analyzed synchronously; current input excluded.
 * Full same-graph/config/rate native restore only; never restore half the pair.
 * No speech-quality, transparent reconstruction, browser or realtime guarantee.
 */
export const spectralCrossSynthesis = defineSubgraph((config: SpectralCrossSynthesisConfig) => {
  const { size, maxGain } = config, half = size / 2;
  if (!Number.isFinite(maxGain) || maxGain < 1 || maxGain > 16) {
    throw new RangeError('spectralCrossSynthesis maxGain must be finite in [1,16]');
  }
  const modulator = instantiate(magnitudeTap, config, { name: 'modulator' });
  const framing = createStftIdentity(config, 256, spectrum => {
    const calculateGain = (k: Node<'i32'>) => {
      const re = spectrum.real(k), im = select(k.eq(0).or(k.eq(half)), f64(0), spectrum.imag(k));
      const magnitude = re.mul(re).add(im.mul(im)).sqrt();
      const denominator = select(magnitude.gt(0), magnitude, f64(1));
      const ratio = select(magnitude.gt(0), modulator.magnitude(k).div(denominator).min(maxGain), f64(0));
      const mix = amount.read().div(scale);
      gains.write(k, f64(1).sub(mix).add(mix.mul(ratio)).mul(scale));
    };
    spectralForEach(half, calculateGain); calculateGain(i32(half));
    const canonical = (index: Node<'i32'>) => index.min(i32(size).sub(index));
    return {
      real(k: number | Node<'i32'>) {
        const index = typeof k === 'number' ? i32(k) : k, pair = canonical(index);
        return select(amount.read().eq(0), spectrum.real(index), spectrum.real(pair).mul(gains.read(pair).div(scale)));
      },
      imag(k: number | Node<'i32'>) {
        const index = typeof k === 'number' ? i32(k) : k, pair = canonical(index);
        const value = select(pair.eq(0).or(pair.eq(half)), f64(0), spectrum.imag(pair).mul(gains.read(pair).div(scale)));
        return select(amount.read().eq(0), spectrum.imag(index), select(index.gt(half), value.neg(), value));
      },
    };
  });
  const amount = state.f64(0).expose({ name: 'amountScaled', snapshot: 'transient' });
  const gains = state.buffer.f64({ size: half + 1 }).expose({ name: 'gainsScaled', snapshot: 'transient' });
  return {
    tick(carrier: Node<'f32'>, inputModulator: Node<'f32'>, blend: Node<'f32'>, reset: Node<'bool'>, everyNSamples: EveryNSamples): Node<'f32'> {
      amount.write(boundedAmount(blend));
      modulator.tick(inputModulator, reset, everyNSamples);
      return framing.tick(carrier, reset, everyNSamples);
    },
  };
});
