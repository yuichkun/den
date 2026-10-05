import { defineSubgraph, f32, f64, floor, i32, or, pow, select, state, type Node } from '@unworklet/core';

export type DriveCurve = 'hard' | 'soft' | 'asymmetric' | 'fold';
export type DriveQuality = 'direct' | 'adaa';
export interface DriveConfig {
  sampleRate: number;
  curve: DriveCurve;
  /** Immutable quality. ADAA is first-order, not oversampling or a bandlimit. */
  quality?: DriveQuality;
  /** Explicit wet-path DC blocker; zero (default) disables it. Range [0, 200] Hz. */
  dcBlockHz?: number;
}
export interface ReductionConfig { sampleRate: number }

// Exact binary scaling preserves recoverable f32 subnormals through the upstream
// state-write |x| < 1e-30 flush. Values and arithmetic remain bounded f64.
const HISTORY_SCALE = 2 ** 100;
function bounded(value: Node<'f32'>, min: number, max: number, fallback: number) {
  const x = f64(value);
  return select(x.eq(x), x, f64(fallback)).clamp(min, max);
}
function checkRate(rate: number) {
  if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) {
    throw new RangeError('drive/reduction sampleRate must be finite and in [8000, 192000] Hz');
  }
}
function soft(x: Node<'f64'>) {
  const z = x.clamp(-1, 1);
  return z.mul(f64(1.5).sub(z.mul(z).mul(0.5)));
}
function softIntegral(x: Node<'f64'>) {
  const a = x.abs(), z = a.min(1), z2 = z.mul(z);
  return z2.mul(f64(0.75).sub(z2.mul(0.125))).add(a.sub(1).max(0));
}
function shape(x: Node<'f64'>, curve: DriveCurve): Node<'f64'> {
  if (curve === 'hard') return x.clamp(-1, 1);
  if (curve === 'soft') return soft(x);
  if (curve === 'asymmetric') return select(x.lt(0), soft(x.mul(2)).mul(0.5), soft(x));
  const phase = x.add(1).sub(floor(x.add(1).div(4)).mul(4));
  // Avoid subtracting nearly equal O(1) values in the linear central segment.
  return select(x.abs().lte(1), x, f64(1).sub(phase.sub(2).abs()));
}
function integral(x: Node<'f64'>, curve: DriveCurve): Node<'f64'> {
  if (curve === 'hard') {
    const a = x.abs(), z = a.min(1);
    return z.mul(z).mul(0.5).add(a.sub(1).max(0));
  }
  if (curve === 'soft') return softIntegral(x);
  if (curve === 'asymmetric') return select(x.lt(0), softIntegral(x.mul(2)).mul(0.25), softIntegral(x));
  const phase = x.add(1).sub(floor(x.add(1).div(4)).mul(4));
  const periodic = select(phase.lte(2), phase.mul(phase).mul(0.5).sub(phase), phase.mul(3).sub(phase.mul(phase).mul(0.5)).sub(4)).add(0.5);
  return select(x.abs().lte(1), x.mul(x).mul(0.5), periodic);
}

/** Fixed analytic memoryless waveshaper, optional first-order ADAA and DC block. */
export const drive = defineSubgraph((config: DriveConfig) => {
  checkRate(config.sampleRate);
  const { curve, quality = 'adaa', dcBlockHz = 0 } = config;
  if (!['hard', 'soft', 'asymmetric', 'fold'].includes(curve)) throw new RangeError('unknown drive curve');
  if (quality !== 'direct' && quality !== 'adaa') throw new RangeError('unknown drive quality');
  if (!Number.isFinite(dcBlockHz) || dcBlockHz < 0 || dcBlockHz > 200) throw new RangeError('drive dcBlockHz must be in [0, 200] Hz');
  const previous = quality === 'adaa' ? state.f64(0).named('previous-driven-scaled') : undefined;
  const dryPrevious = quality === 'adaa' ? state.f64(0).named('previous-dry-scaled') : undefined;
  const dcInput = dcBlockHz > 0 ? state.f64(0).named('dc-input-scaled') : undefined;
  const dcOutput = dcBlockHz > 0 ? state.f64(0).named('dc-output-scaled') : undefined;
  const pole = Math.exp(-2 * Math.PI * dcBlockHz / config.sampleRate);
  return {
    /** Once per sample. Input [-8,8], linear drive [0,32], wet mix [0,1]. */
    tick(input: Node<'f32'>, gain: Node<'f32'>, mix: Node<'f32'>, reset: Node<'bool'>) {
      const dry = bounded(input, -8, 8, 0), x = dry.mul(bounded(gain, 0, 32, 0));
      const blend = bounded(mix, 0, 1, 0);
      let wet: Node<'f64'>, alignedDry: Node<'f64'>;
      if (previous && dryPrevious) {
        const last = select(reset, f64(0), previous.read().div(HISTORY_SCALE));
        const lastDry = select(reset, f64(0), dryPrevious.read().div(HISTORY_SCALE));
        const difference = x.sub(last);
        const close = difference.abs().lte(1e-5);
        // Both select branches execute. Protect the unused quotient as well.
        // A continuous curve with max slope 1.5 has midpoint error <= 3.75e-6
        // on this interval; smooth cubic interiors have O(difference²) error.
        wet = select(close, shape(x.add(last).mul(0.5), curve), integral(x, curve).sub(integral(last, curve)).div(select(close, f64(1), difference)));
        alignedDry = dry.add(lastDry).mul(0.5);
        previous.write(x.mul(HISTORY_SCALE));
        dryPrevious.write(dry.mul(HISTORY_SCALE));
      } else {
        wet = shape(x, curve);
        alignedDry = dry;
      }
      if (dcInput && dcOutput) {
        const lastInput = select(reset, f64(0), dcInput.read().div(HISTORY_SCALE));
        const lastOutput = select(reset, f64(0), dcOutput.read().div(HISTORY_SCALE));
        const blocked = wet.sub(lastInput).add(lastOutput.mul(pole));
        dcInput.write(wet.mul(HISTORY_SCALE));
        dcOutput.write(blocked.mul(HISTORY_SCALE));
        wet = blocked;
      }
      return f32(alignedDry.mul(f64(1).sub(blend)).add(wet.mul(blend)));
    },
  };
});

/** Signed-PCM quantizer plus sample hold. Aliasing is intentional; no AA claim. */
export const reduction = defineSubgraph((config: ReductionConfig) => {
  checkRate(config.sampleRate);
  const held = state.f64(0).named('held-scaled');
  const remaining = state.i32(0).named('remaining');
  return {
    /** Bits [2,24], hold period [1,4096] samples, both floored at capture. */
    tick(input: Node<'f32'>, bits: Node<'f32'>, holdSamples: Node<'f32'>, mix: Node<'f32'>, reset: Node<'bool'>) {
      const x = bounded(input, -1, 1, 0), blend = bounded(mix, 0, 1, 0);
      const count = select(reset, i32(0), remaining.read());
      const capture = or(reset, count.eq(0));
      const steps = pow(f64(2), floor(bounded(bits, 2, 24, 24)).sub(1));
      // Exactly 2^bits signed levels: [-1, 1 - 1/steps]. Ties round upward.
      const quantized = floor(x.mul(steps).add(0.5)).clamp(steps.neg(), steps.sub(1)).div(steps);
      const wet = select(capture, quantized, held.read().div(HISTORY_SCALE));
      held.write(wet.mul(HISTORY_SCALE));
      remaining.write(select(capture, i32(floor(bounded(holdSamples, 1, 4096, 1))).sub(1), count.sub(1)));
      return f32(x.mul(f64(1).sub(blend)).add(wet.mul(blend)));
    },
  };
});
