import { defineSubgraph, f32, f64, floor, i32, select, state, type Node } from '@unworklet/core';
import type { DriveCurve } from './drive.js';

/** Matched linear-phase bulk delay. FIR precursors exist before sample 32. */
export const OVERSAMPLED_DRIVE_LATENCY_SAMPLES = 32;
export interface OversampledDriveConfig {
  /** Host rate. The fixed arithmetic shaper has no nested sample-rate runtime. */
  sampleRate: number;
  factor: 2 | 4;
  curve: DriveCurve;
}
const SCALE = 2 ** 128;
function bounded(value: Node<'f32'>, low: number, high: number) {
  const wide = f64(value);
  return select(wide.eq(wide), wide, f64(0)).clamp(low, high);
}
function soft(value: Node<'f64'>) {
  const x = value.clamp(-1, 1);
  return x.mul(f64(1.5).sub(x.mul(x).mul(.5)));
}
function shape(x: Node<'f64'>, curve: DriveCurve) {
  if (curve === 'hard') return x.clamp(-1, 1);
  if (curve === 'soft') return soft(x);
  if (curve === 'asymmetric') return select(x.lt(0), soft(x.mul(2)).mul(.5), soft(x));
  const phase = x.add(1).sub(floor(x.add(1).div(4)).mul(4));
  return select(x.abs().lte(1), x, f64(1).sub(phase.sub(2).abs()));
}
function kernel(factor: 2 | 4) {
  const half = 16 * factor, cutoff = .45 / factor;
  const values = Array.from({ length: 2 * half + 1 }, (_, k) => {
    const distance = Math.abs(k - half);
    if (distance === half) return 0;
    const ideal = distance === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
    return ideal * (.42 + .5 * Math.cos(Math.PI * distance / half) + .08 * Math.cos(2 * Math.PI * distance / half));
  });
  const sum = values.reduce((a, b) => a + b, 0);
  return values.map(value => value / sum);
}

/** Fixed polyphase interpolation -> memoryless shape -> FIR/phase-zero
 * decimation. Both factors have 32-sample matched bulk delay and deliberate
 * high-frequency rolloff. Dry follows the exact linear resampling cascade.
 */
export const oversampledDrive = defineSubgraph((config: OversampledDriveConfig) => {
  const { sampleRate, factor, curve } = config;
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('oversampledDrive sampleRate must be in [8000,192000] Hz');
  if (factor !== 2 && factor !== 4) throw new RangeError('oversampledDrive factor must be 2 or 4');
  if (!['hard', 'soft', 'asymmetric', 'fold'].includes(curve)) throw new RangeError('unknown oversampledDrive curve');
  const h = kernel(factor), size = h.length;
  const dryKernel = Array.from({ length: 65 }, (_, j) => factor * h.reduce((sum, value, k) => sum + value * (h[factor * j - k] ?? 0), 0));
  const driven = state.buffer.f64({ size: 33 }).expose({ name: 'driven-scaled', snapshot: 'persistent' });
  const raw = state.buffer.f64({ size: 65 }).expose({ name: 'dry-scaled', snapshot: 'persistent' });
  const shaped = state.buffer.f64({ size }).expose({ name: 'shaped-scaled', snapshot: 'persistent' });
  const drivenCursor = state.i32(0).named('driven-cursor'), dryCursor = state.i32(0).named('dry-cursor');
  const highCursor = state.i32(0).named('high-cursor');
  const baseValid = state.i32(0).named('base-valid'), highValid = state.i32(0).named('high-valid');
  const up = state.f64(0).expose({ name: 'interpolated-scaled', snapshot: 'transient' });
  const wet = state.f64(0).expose({ name: 'wet-sum-scaled', snapshot: 'transient' });
  const dry = state.f64(0).expose({ name: 'dry-sum-scaled', snapshot: 'transient' });
  return {
    /** Once per host sample. Input [-8,8], linear gain [0,32], mix [0,1].
     * Reset invalidates old history before consuming the current sample. */
    tick(input: Node<'f32'>, gain: Node<'f32'>, mix: Node<'f32'>, reset: Node<'bool'>): Node<'f32'> {
      const audio = bounded(input, -8, 8), amount = bounded(mix, 0, 1);
      baseValid.write(select(reset, i32(1), baseValid.read().add(1).min(65)));
      highValid.write(select(reset, i32(0), highValid.read()));
      raw.write(dryCursor.read(), audio.mul(SCALE));
      driven.write(drivenCursor.read(), audio.mul(bounded(gain, 0, 32)).mul(SCALE));
      const baseAt = (lag: number) => select(baseValid.read().gt(lag), driven.read(drivenCursor.read().add(33 - lag).mod(33)), f64(0));
      const highAt = (lag: number) => select(highValid.read().gt(lag), shaped.read(highCursor.read().add(size - lag).mod(size)), f64(0));
      // These are fixed construction-time phases, not a second graph scheduler.
      // Filtering suppresses images before and after the nonlinearity.
      for (let phase = 0; phase < factor; phase++) {
        up.write(0);
        for (let tap = phase; tap < size; tap += factor) {
          if (h[tap] !== 0) up.write(up.read().add(baseAt((tap - phase) / factor).mul(factor * h[tap])));
        }
        shaped.write(highCursor.read(), shape(up.read().div(SCALE), curve).mul(SCALE));
        highValid.write(highValid.read().add(1).min(size));
        if (phase === 0) {
          wet.write(0);
          for (let tap = 0; tap < size; tap++) if (h[tap] !== 0) wet.write(wet.read().add(highAt(tap).mul(h[tap])));
        }
        highCursor.write(highCursor.read().add(1).mod(size));
      }
      dry.write(0);
      for (let tap = 0; tap < dryKernel.length; tap++) {
        if (dryKernel[tap] !== 0) {
          const previous = select(baseValid.read().gt(tap), raw.read(dryCursor.read().add(65 - tap).mod(65)), f64(0));
          dry.write(dry.read().add(previous.mul(dryKernel[tap])));
        }
      }
      drivenCursor.write(drivenCursor.read().add(1).mod(33));
      dryCursor.write(dryCursor.read().add(1).mod(65));
      return f32(dry.read().mul(f64(1).sub(amount)).add(wet.read().mul(amount)).div(SCALE));
    },
  };
});
