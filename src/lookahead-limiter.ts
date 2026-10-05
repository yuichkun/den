import { defineSubgraph, f32, f64, i32, instantiate, select, state, type Node } from '@unworklet/core';
import { envelopeFollower } from './dynamics.js';

export interface LookaheadLimiterConfig {
  sampleRate: number;
  /** Fixed integer latency/allocation, 0..2048 samples. No implicit default. */
  lookaheadSamples: number;
}
export interface LookaheadLimiterControls {
  /** Current-output sample ceiling in dBFS, clamped to [-120,0]; nonfinite -> 0. */
  ceilingDb: Node<'f32'>;
  /** Peak-detector release, 0..30 seconds; nonfinite -> 0. Attack is immediate. */
  release: Node<'f32'>;
  /** Invalidate all history before accepting this sample. */
  reset: Node<'bool'>;
}
const SCALE = 2 ** 128;
function finite(input: Node<'f32'>) {
  return select(input.eq(input).and(input.abs().lte(3.4028234663852886e38)), input, f32(0));
}

/** Bounded stereo-linked sample-peak limiter. Not a true-peak limiter. */
export const lookaheadLimiter = defineSubgraph((config: LookaheadLimiterConfig) => {
  const { sampleRate, lookaheadSamples: delay } = config;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('lookaheadLimiter sampleRate must be an integer in [8000,192000]');
  }
  if (!Number.isInteger(delay) || delay < 0 || delay > 2048) {
    throw new RangeError('lookaheadLimiter lookaheadSamples must be an integer in [0,2048]');
  }
  const size = delay + 1, capacity = 2 ** Math.ceil(Math.log2(size));
  // Native buffer writes flush magnitudes below 1e-30. Exact binary scaling
  // preserves every finite f32 value, including subnormals, without overflow.
  const leftHistory = state.buffer.f64({ size }).expose({ name: 'leftScaled', snapshot: 'persistent' });
  const rightHistory = state.buffer.f64({ size }).expose({ name: 'rightScaled', snapshot: 'persistent' });
  const peaks = state.buffer.f64({ size: capacity * 2 }).expose({ name: 'peakTreeScaled', snapshot: 'persistent' });
  const cursor = state.i32(0).named('cursor'), valid = state.i32(0).named('valid');
  const follower = instantiate(envelopeFollower, { sampleRate, mode: 'peak' }, { name: 'detector' });
  return {
    latencySamples: delay,
    latencySeconds: delay / sampleRate,
    /** Exactly once per sample. Dry outputs have the same fixed latency. */
    tick(left: Node<'f32'>, right: Node<'f32'>, controls: LookaheadLimiterControls) {
      const write = select(controls.reset, i32(0), cursor.read());
      const available = select(controls.reset, i32(0), valid.read()).add(1).min(size);
      const l = f64(finite(left)).mul(SCALE), r = f64(finite(right)).mul(SCALE);
      leftHistory.write(write, l); rightHistory.write(write, r);
      peaks.write(write.add(capacity), l.abs().max(r.abs()));
      // At reset the valid leaves form an initially empty prefix. Sequential
      // refill ensures each included sibling was rebuilt since that reset.
      // Other siblings (including permanently unused leaves) are read as zero.
      // Once full, all real leaves stay valid across arbitrary ring wraps.
      for (let width = 2; width <= capacity; width *= 2) {
        const block = write.div(width), first = block.mul(width), node = block.add(capacity / width);
        const low = select(first.lt(available), peaks.read(node.mul(2)), f64(0));
        const high = select(first.add(width / 2).lt(available), peaks.read(node.mul(2).add(1)), f64(0));
        peaks.write(node, low.max(high));
      }
      const windowPeak = f32(peaks.read(1).div(SCALE));
      const envelope = follower.tick(windowPeak, { attack: f32(0), release: controls.release, reset: controls.reset });
      const ceiling = finite(controls.ceilingDb).clamp(-120, 0).mul(Math.LN10 / 20).exp();
      const gain = select(envelope.gt(0), f64(ceiling).div(select(envelope.gt(0), f64(envelope), f64(1))).min(1), f64(1));
      const read = write.add(1).mod(size);
      const ready = available.eq(size);
      const dryLeft = select(ready, leftHistory.read(read).div(SCALE), f64(0));
      const dryRight = select(ready, rightHistory.read(read).div(SCALE), f64(0));
      cursor.write(read); valid.write(available);
      return {
        // Keep the gain f64 through multiplication: full-range f32 input at a
        // -120dB ceiling would otherwise quantize its tiny gain to a few ulps.
        left: f32(dryLeft.mul(gain)).clamp(ceiling.neg(), ceiling),
        right: f32(dryRight.mul(gain)).clamp(ceiling.neg(), ceiling),
        dryLeft: f32(dryLeft), dryRight: f32(dryRight),
        envelope, windowPeak, ceiling,
        /** Diagnostic only: this f32 conversion may underflow for extreme audio. */
        gain: f32(gain),
      };
    },
  };
});
