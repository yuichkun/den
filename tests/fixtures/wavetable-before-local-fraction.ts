import { defineSubgraph, f32, f64, i32, select, state, type Node } from '@unworklet/core';
import type { ResidentSample } from '../../src/sample.js';

export interface WavetableConfig {
  sampleRate: number;
  /** Shared mono PCM. Concatenate complete cycles, without duplicate end samples. */
  sample: ResidentSample;
  /** Samples per cycle, integer4..4096. */
  frameLength: number;
  /** Fixed number of morph frames, integer1..16; total must fit resident capacity. */
  frameCount: number;
  /** Initial/reset phase in cycles, [0,1). */
  phaseCycles?: number;
}
export interface WavetableControls {
  /** Hz clipped to [0,.45*sampleRate], NaN becomes0. */
  frequencyHz: Node<'f32'>;
  /** Fractional frame index, clipped to [0,frameCount−1], NaN becomes0. */
  frame: Node<'f32'>;
  /** Level-sensitive phase reset. A resident revision also restarts phase. */
  reset: Node<'bool'>;
}
function integer(value: number, low: number, high: number, name: string) {
  if (!Number.isInteger(value) || value < low || value > high) throw new RangeError(`${name} must be an integer in [${low},${high}]`);
}
function bounded(value: Node<'f32'>, high: number) {
  return select(value.eq(value), f64(value), f64(0)).clamp(0, high);
}

/** Two periodic linear cycle reads and linear frame morph. No automatic bandlimit. */
export const wavetableSource = defineSubgraph((config: WavetableConfig) => {
  const { sampleRate, sample, frameLength, frameCount, phaseCycles = 0 } = config;
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('wavetable sampleRate must be in [8000,192000] Hz');
  integer(sample.capacity, 4, 65536, 'resident capacity');
  integer(frameLength, 4, 4096, 'frameLength'); integer(frameCount, 1, 16, 'frameCount');
  const required = frameLength * frameCount;
  if (required > sample.capacity) throw new RangeError('wavetable frames must fit resident capacity');
  if (!Number.isFinite(phaseCycles) || phaseCycles < 0 || phaseCycles >= 1) throw new RangeError('phaseCycles must be in [0,1)');
  // Phase accepts f64 configuration, including Number.MIN_VALUE: scaling
  // by 2^1020 keeps even that value above the native 1e-30 flush. Phase
  // is always <1 before scaling, leaving >16x finite headroom. Morph is
  // f32 input and only needs 2^128; neither scaled value touches PCM.
  const scale = 2 ** 1020, frameScale = 2 ** 128;
  const phase = state.f64(phaseCycles * scale).named('scaledPhase'), revision = state.i32(-1).named('revision');
  // Native materialization bounds capture size even when resident.read expands
  // its four wrap/validation paths. These are ordinary same-schema snapshot slots.
  const current = state.f64(phaseCycles * scale).named('scaledCurrentPhase'), scan = state.f64(0).named('scaledFrame');
  const lower = state.i32(0).named('lowerStart'), upper = state.i32(0).named('upperStart');
  return { tick(c: WavetableControls) {
    const changed = sample.revision().eq(revision.read()).not();
    current.write(select(c.reset.or(changed), f64(phaseCycles * scale), phase.read()));
    scan.write(bounded(c.frame, frameCount - 1).mul(frameScale));
    const frame = scan.read().div(frameScale), p = current.read().div(scale);
    lower.write(i32(frame.floor()).mul(frameLength));
    upper.write(i32(frame.floor()).add(1).min(frameCount - 1).mul(frameLength));
    const offset = p.mul(frameLength);
    const a = sample.read(f64(lower.read()).add(offset), lower.read(), lower.read().add(frameLength), true);
    const b = sample.read(f64(upper.read()).add(offset), upper.read(), upper.read().add(frameLength), true);
    const missing = sample.length().lt(required), mix = frame.sub(frame.floor());
    const output = select(missing, f32(0), f32(f64(a).mul(f64(1).sub(mix)).add(f64(b).mul(mix))));
    phase.write(p.add(bounded(c.frequencyHz, .45 * sampleRate).div(sampleRate)).frac().mul(scale));
    revision.write(sample.revision());
    return { output, missing };
  } };
});

