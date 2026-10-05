import { defineSubgraph, f64, i32, select, state, type EveryNSamples, type Node } from '@unworklet/core';
import { spectralForEach } from './spectral-fft.js';
import { createStftIdentity } from './spectral-stft.js';

export interface SpectralGateConfig {
  /** Construction-fixed power of two in [8,1024]. Reference alignment is size samples. */
  size: number;
  /** Exactly size/2 or size/4. Rebuild to change. */
  hopSize: number;
}

/** Framewise hard spectral gate; periodic sqrt-Hann WOLA, no ballistics/limiter.
 * Call once per sample inside stride-1 forSample with its everyNSamples.
 * Input must be finite normalized f32 [-1,1]; attenuation can raise output peaks.
 * Threshold: single-sided coherent-window bin amplitude, not RMS or dB.
 * Floor: linear gain. Controls are sampled only on committed frame boundaries.
 * NaN threshold becomes 0, NaN floor becomes 1 (all-pass); infinities clamp.
 * Reference delay is N, but processed transients may spread across each frame.
 * Drain at least 2*size zero input samples after the source ends.
 * Reset immediately silences/discards input, without rephasing frame boundaries.
 * Offline CANDIDATE. No browser/realtime guarantee.
 */
export const spectralGate = defineSubgraph((config: SpectralGateConfig) => {
  const framing = createStftIdentity(config, 1024, spectrum => {
    const writeGain = (k: Node<'i32'>) => {
      const real = spectrum.real(k), imag = spectrum.imag(k);
      const factor = select(k.eq(0).or(k.eq(half)), f64(1), f64(4));
      const power = real.mul(real).add(imag.mul(imag)).mul(factor);
      gains.write(k, select(power.gte(thresholdSquared.read()), f64(scale), floor.read()));
    };
    spectralForEach(half, writeGain);
    writeGain(i32(half));
    const allPass = thresholdSquared.read().eq(0).or(floor.read().eq(scale));
    const canonical = (k: Node<'i32'>) => k.min(i32(size).sub(k));
    return {
      real: (k: number | Node<'i32'>) => {
        const index = typeof k === 'number' ? i32(k) : k, pair = canonical(index);
        const gated = spectrum.real(pair).mul(gains.read(pair).div(scale));
        return select(allPass, spectrum.real(index), gated);
      },
      imag: (k: number | Node<'i32'>) => {
        const index = typeof k === 'number' ? i32(k) : k, pair = canonical(index);
        const sign = select(index.gt(half), f64(-1), f64(1));
        const gated = select(pair.eq(0).or(pair.eq(half)), f64(0), spectrum.imag(pair).mul(sign).mul(gains.read(pair).div(scale)));
        return select(allPass, spectrum.imag(index), gated);
      },
    };
  });
  const { size } = config, half = size / 2, scale = 2 ** 128;
  const maxF32 = 3.4028234663852886e38;
  // Sum of periodic sqrt-Hann: sum_{n=0}^{N-1} sin(pi*n/N).
  const windowSum = 1 / Math.tan(Math.PI / (2 * size));
  const thresholdSquared = state.f64(0).expose({ name: 'thresholdSquaredScaled', snapshot: 'transient' });
  const floor = state.f64(scale).expose({ name: 'floorScaled', snapshot: 'transient' });
  const gains = state.buffer.f64({ size: half + 1 }).expose({ name: 'gainsScaled', snapshot: 'transient' });
  return {
    tick(input: Node<'f32'>, threshold: Node<'f32'>, floorGain: Node<'f32'>, reset: Node<'bool'>, everyNSamples: EveryNSamples): Node<'f32'> {
      // Materialize outer-sample controls before the nested native buffer loops.
      // Scaling preserves f32 subnormals through 0.4.1's 1e-30 buffer flush.
      const level = select(threshold.eq(threshold), f64(threshold).max(0).min(maxF32), f64(0)).mul(windowSum * scale);
      thresholdSquared.write(level.mul(level));
      floor.write(select(floorGain.eq(floorGain), f64(floorGain).max(0).min(1), f64(1)).mul(scale));
      return framing.tick(input, reset, everyNSamples);
    },
  };
});
