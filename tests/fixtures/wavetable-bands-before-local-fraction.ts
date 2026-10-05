import { defineSubgraph, f32, f64, i32, select, state } from '@unworklet/core';
import type { WavetableConfig, WavetableControls } from '../../src/wavetable.js';

export interface PreparedWavetableBands {
  /** Band-major, then frame-major complete cycles, without duplicated endpoints. */
  data: Float32Array;
  frameLength: number;
  frameCount: number;
  /** Descending retained positive harmonics; DC is preserved in every band. */
  harmonicLimits: readonly number[];
}
export interface WavetableBandsOptions {
  /** Original finite mono cycles. Equal power-of-two lengths 16..4096; 1..16 frames.
   * All derived bands together must fit 65536 samples. Input is never changed. */
  frames: readonly Float32Array[];
}
/** Layout is the fixed schedule produced by prepareWavetableBands. */
export interface BandedWavetableConfig extends WavetableConfig {
  /** Power of two, 16..4096 samples per cycle. */
  frameLength: number;
  /** 1..16 morph frames; frameLength * frameCount * derived band count must
   * fit both the shared resident capacity and the 65536-sample native limit. */
  frameCount: number;
}

function layout(length: number, count: number) {
  if (!Number.isInteger(length) || length < 16 || length > 4096 || !Number.isInteger(Math.log2(length)) ||
      !Number.isInteger(count) || count < 1 || count > 16) throw new RangeError('banded wavetable requires power-of-two frameLength 16..4096 and frameCount 1..16');
  const harmonics: number[] = [];
  for (let h = length / 2 - 1; h >= 1; h = Math.floor(h / 2)) harmonics.push(h);
  const required = length * count * harmonics.length;
  if (required > 65536) throw new RangeError('all wavetable bands must fit 65536 samples');
  return { harmonics, required };
}

// Host-only radix-2 FFT. This runs before native ingress, never in audio processing.
function transform(real: Float64Array, imag: Float64Array, inverse: boolean) {
  const size = real.length;
  for (let n = 1, j = 0; n < size; n++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (n < j) { const r = real[n], im = imag[n]; real[n] = real[j]; imag[n] = imag[j]; real[j] = r; imag[j] = im; }
  }
  for (let width = 2; width <= size; width *= 2) {
    for (let base = 0; base < size; base += width) for (let k = 0; k < width / 2; k++) {
      const angle = (inverse ? 2 : -2) * Math.PI * k / width, c = Math.cos(angle), s = Math.sin(angle);
      const a = base + k, b = a + width / 2;
      const tr = c * real[b] - s * imag[b], ti = s * real[b] + c * imag[b];
      real[b] = real[a] - tr; imag[b] = imag[a] - ti; real[a] += tr; imag[a] += ti;
    }
  }
  if (inverse) for (let n = 0; n < size; n++) { real[n] /= size; imag[n] /= size; }
}

/** Prepare harmonic-truncated pitch bands outside the audio callback. No per-band
 * normalization, resampling, loader, or provenance/license assumption is added.
 * Reject nonfinite input or reconstruction that overflows float32. DC, phase and
 * retained harmonic gain are preserved within FFT/float32 roundoff. */
export function prepareWavetableBands({ frames }: WavetableBandsOptions): PreparedWavetableBands {
  const frameCount = frames.length, frameLength = frames[0]?.length ?? 0;
  const { harmonics, required } = layout(frameLength, frameCount);
  for (const frame of frames) {
    if (!(frame instanceof Float32Array) || frame.length !== frameLength || frame.some(x => !Number.isFinite(x))) {
      throw new RangeError('wavetable frames must be equal-length finite Float32Arrays');
    }
  }
  const data = new Float32Array(required);
  const real = new Float64Array(frameLength), imag = new Float64Array(frameLength);
  const r = new Float64Array(frameLength), im = new Float64Array(frameLength);
  for (let frame = 0; frame < frameCount; frame++) {
    real.set(frames[frame]); imag.fill(0);
    transform(real, imag, false);
    for (let band = 0; band < harmonics.length; band++) {
      r.fill(0); im.fill(0); const limit = harmonics[band];
      r[0] = real[0];
      // Explicit conjugate pairs guarantee a real table despite FFT roundoff.
      for (let h = 1; h <= limit; h++) {
        r[h] = (real[h] + real[frameLength - h]) / 2;
        im[h] = (imag[h] - imag[frameLength - h]) / 2;
        r[frameLength - h] = r[h]; im[frameLength - h] = -im[h];
      }
      transform(r, im, true);
      const offset = (band * frameCount + frame) * frameLength;
      for (let n = 0; n < frameLength; n++) {
        const value = Math.fround(r[n]);
        if (!Number.isFinite(value)) throw new RangeError('prepared wavetable exceeds finite float32 PCM range');
        data[offset + n] = value;
      }
    }
  }
  return { data, frameLength, frameCount, harmonicLimits: Object.freeze(harmonics) };
}

function bounded(value: WavetableControls['frequencyHz'], high: number) {
  return select(value.eq(value), f64(value), f64(0)).clamp(0, high);
}

/** Four periodic linear reads: frame morph in two neighboring pitch bands.
 * Static harmonic truncation is not a brickwall reconstruction filter and does
 * not remove interpolation images or bandwidth from modulation/reset/asset edits. */
export const bandedWavetableSource = defineSubgraph((config: BandedWavetableConfig) => {
  const { sampleRate, sample, frameLength, frameCount, phaseCycles = 0 } = config;
  const { harmonics, required } = layout(frameLength, frameCount);
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('banded wavetable sampleRate must be in [8000,192000] Hz');
  if (!Number.isInteger(sample.capacity) || sample.capacity < required || sample.capacity > 65536) throw new RangeError('all wavetable bands must fit resident capacity');
  if (!Number.isFinite(phaseCycles) || phaseCycles < 0 || phaseCycles >= 1) throw new RangeError('phaseCycles must be in [0,1)');
  const phaseScale = 2 ** 1020, controlScale = 2 ** 128;
  const phase = state.f64(phaseCycles * phaseScale).named('scaledPhase'), revision = state.i32(-1).named('revision');
  const current = state.f64(phaseCycles * phaseScale).named('scaledCurrentPhase');
  const scan = state.f64(0).named('scaledFrame'), pitch = state.f64(0).named('scaledFrequency'), band = state.f64(0).named('scaledBand');
  const frameLo = state.i32(0).named('frameLo'), frameHi = state.i32(0).named('frameHi');
  const bandLo = state.i32(0).named('bandLo'), bandHi = state.i32(0).named('bandHi');
  const starts = Array.from({ length: 4 }, (_, i) => state.i32(0).named(`start${i}`));
  return { tick(c: WavetableControls) {
    current.write(select(c.reset.or(sample.revision().eq(revision.read()).not()), f64(phaseCycles * phaseScale), phase.read()));
    scan.write(bounded(c.frame, frameCount - 1).mul(controlScale));
    pitch.write(bounded(c.frequencyHz, .45 * sampleRate).mul(controlScale));
    const frequency = pitch.read().div(controlScale), frame = scan.read().div(controlScale), p = current.read().div(phaseScale);
    // Nonoverlapping transitions: the bright H band has zero weight by .45*sr/H.
    let position = f64(0);
    for (const h of harmonics.slice(0, -1)) {
      const start = .225 * sampleRate / h;
      position = position.add(frequency.sub(start).div(start).clamp(0, 1));
    }
    band.write(position.mul(controlScale));
    const b = band.read().div(controlScale), frameMix = frame.sub(frame.floor()), bandMix = b.sub(b.floor());
    frameLo.write(i32(frame.floor())); frameHi.write(frameLo.read().add(1).min(frameCount - 1));
    bandLo.write(i32(b.floor())); bandHi.write(bandLo.read().add(1).min(harmonics.length - 1));
    starts[0].write(bandLo.read().mul(frameCount).add(frameLo.read()).mul(frameLength));
    starts[1].write(bandLo.read().mul(frameCount).add(frameHi.read()).mul(frameLength));
    starts[2].write(bandHi.read().mul(frameCount).add(frameLo.read()).mul(frameLength));
    starts[3].write(bandHi.read().mul(frameCount).add(frameHi.read()).mul(frameLength));
    const values = starts.map(start => sample.read(f64(start.read()).add(p.mul(frameLength)), start.read(), start.read().add(frameLength), true));
    const a = f64(values[0]).mul(f64(1).sub(frameMix)).add(f64(values[1]).mul(frameMix));
    const z = f64(values[2]).mul(f64(1).sub(frameMix)).add(f64(values[3]).mul(frameMix));
    const missing = sample.length().lt(required);
    const output = select(missing, f32(0), f32(a.mul(f64(1).sub(bandMix)).add(z.mul(bandMix))));
    phase.write(p.add(frequency.div(sampleRate)).frac().mul(phaseScale)); revision.write(sample.revision());
    return { output, missing };
  } };
});
