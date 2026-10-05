import { defineSubgraph, f64, i32, select, state, type EveryNSamples, type Node } from '@unworklet/core';
import { spectralForEach } from './spectral-fft.js';
import { createStftIdentity } from './spectral-stft.js';

export interface SpectralFreezeConfig {
  /** Construction-fixed power of two in [8,1024]. Reference alignment is size samples. */
  size: number;
  /** Exactly size/2 or size/4. Rebuild to change. */
  hopSize: number;
}

/** Bin-centered spectral freeze, periodic sqrt-Hann WOLA. Offline CANDIDATE.
 * Call once per sample inside stride-1 forSample with its everyNSamples.
 * Finite normalized f32 input [-1,1]. Output is not limited/normalized.
 * At committed t=mH, a high freeze captures [t-N,t) if not already held.
 * Held bins advance by +2*pi*k*H/N per frame (no frequency estimation).
 * A low freeze releases at that frame; existing overlap settles within N.
 * Input/history continue while frozen. Controls between frames are ignored.
 * Reset immediately silences/discards input and invalidates the hold, without
 * rephasing. High freeze recaptures at the next non-reset committed frame.
 * No finite drain while held. With freeze low, drain 2N zero input samples
 * after the later of source end and release request. No realtime guarantee.
 */
export const spectralFreeze = defineSubgraph((config: SpectralFreezeConfig) => {
  // Keep the reviewed framing and FFT unchanged. This persistent modulo-H clock
  // mirrors its cursor%H, including snapshots and reset (which never rephases).
  const framing = createStftIdentity(config, 1024, spectrum => {
    const due = frameClock.read().eq(0);
    const requested = freezeControl.read().and(resetControl.read().not());
    captureNow.write(due.and(requested).and(active.read().not()));
    heldPhase.write(select(due,
      select(requested, select(active.read(), heldPhase.read().add(1).mod(period), i32(0)), i32(0)),
      heldPhase.read()));
    active.write(select(due, requested, active.read()));
    const captureBin = (k: Node<'i32'>) => {
      heldReal.write(k, select(captureNow.read(), spectrum.real(k), heldReal.read(k)));
      heldImag.write(k, select(captureNow.read(),
        select(k.eq(0).or(k.eq(half)), f64(0), spectrum.imag(k)), heldImag.read(k)));
    };
    spectralForEach(half, captureBin); captureBin(i32(half));
    const bin = (k: number | Node<'i32'>) => {
      const index = typeof k === 'number' ? i32(k) : k;
      const pair = index.min(i32(size).sub(index));
      // H=N/2 or N/4: the exact unit rotations need no trig or recurrence.
      const quadrant = pair.mul(heldPhase.read()).mul(4 / period).mod(4);
      const re = heldReal.read(pair), im = heldImag.read(pair);
      const real = select(quadrant.eq(0), re, select(quadrant.eq(1), im.neg(), select(quadrant.eq(2), re.neg(), im)));
      const imag = select(quadrant.eq(0), im, select(quadrant.eq(1), re, select(quadrant.eq(2), im.neg(), re.neg())));
      return { index, pair, real, imag };
    };
    return {
      real(k: number | Node<'i32'>) {
        const value = bin(k);
        return select(active.read(), value.real, spectrum.real(value.index));
      },
      imag(k: number | Node<'i32'>) {
        const value = bin(k);
        const mirrored = select(value.index.gt(half), value.imag.neg(), value.imag);
        const realOnly = select(value.pair.eq(0).or(value.pair.eq(half)), f64(0), mirrored);
        return select(active.read(), realOnly, spectrum.imag(value.index));
      },
    };
  });
  const { size, hopSize } = config, half = size / 2, period = size / hopSize;
  const heldReal = state.buffer.f64({ size: half + 1 }).expose({ name: 'heldRealScaled', snapshot: 'persistent' });
  const heldImag = state.buffer.f64({ size: half + 1 }).expose({ name: 'heldImagScaled', snapshot: 'persistent' });
  const frameClock = state.i32(0).named('frameClock');
  const heldPhase = state.i32(0).named('heldPhase');
  const active = state.bool(false).named('active');
  const freezeControl = state.bool(false).expose({ name: 'freezeControl', snapshot: 'transient' });
  const resetControl = state.bool(false).expose({ name: 'resetControl', snapshot: 'transient' });
  const captureNow = state.bool(false).expose({ name: 'captureNow', snapshot: 'transient' });
  return {
    tick(input: Node<'f32'>, freeze: Node<'bool'>, reset: Node<'bool'>, everyNSamples: EveryNSamples): Node<'f32'> {
      freezeControl.write(freeze); resetControl.write(reset);
      active.write(active.read().and(reset.not()));
      heldPhase.write(select(reset, i32(0), heldPhase.read()));
      const output = framing.tick(input, reset, everyNSamples);
      frameClock.write(frameClock.read().add(1).mod(hopSize));
      return output;
    },
  };
});
