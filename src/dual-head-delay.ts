import { defineSubgraph, f32, f64, i32, select, state, type Node } from '@unworklet/core';

export interface DualHeadDelayConfig {
  /** Match the enclosing processor's ctx.sampleRate; integer 8000..192000. */
  sampleRate: number;
  /** Fixed history allocation, one sample..8 seconds; default 2. */
  maxDelaySeconds?: number;
  /** Fixed fade length, integer 2..65536; default 256. Includes both endpoints. */
  transitionSamples?: number;
}
const HISTORY_SCALE = 2 ** 128;

/** Mono fixed-two-head delay-time crossfade. Once/sample, use tick or one read
 * followed by that read's write. Finite f32 input required. Latest valid requests
 * coalesce until the current fade completes; active read offsets never move.
 * No implicit feedback, mix, bypass, pitch-shifting or time-stretching policy.
 */
export const dualHeadDelay = defineSubgraph((config: DualHeadDelayConfig) => {
  const { sampleRate, maxDelaySeconds = 2, transitionSamples = 256 } = config;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      !Number.isFinite(maxDelaySeconds) || maxDelaySeconds < 1 / sampleRate || maxDelaySeconds > 8 ||
      !Number.isInteger(transitionSamples) || transitionSamples < 2 || transitionSamples > 65536) {
    throw new RangeError('dualHeadDelay requires integer sampleRate [8000,192000], capacity [one sample,8 seconds], and integer transitionSamples [2,65536]');
  }
  // The direct reciprocal capacity check above rejects genuinely sub-sample
  // configurations; this floor only repairs multiplication at that exact bound.
  const maximum = Math.max(1, sampleRate * maxDelaySeconds), size = Math.ceil(maximum) + 2;
  const history = state.buffer.f64({ size }).expose({ name: 'historyScaled', snapshot: 'persistent' });
  const cursor = state.i32(0).named('cursor'), valid = state.i32(0).named('valid');
  const initialized = state.i32(0).named('initialized');
  const current = state.f64(1).named('currentDelaySamples');
  const target = state.f64(1).named('targetDelaySamples');
  const queued = state.f64(1).named('queuedDelaySamples');
  const remaining = state.i32(0).named('remaining');
  // Materialize the read result before the write commits a completed fade.
  const wet = state.f64(0).expose({ name: 'wetScaled', snapshot: 'transient' });
  const active = state.i32(0).expose({ name: 'active', snapshot: 'transient' });
  function read(timeSeconds: Node<'f32'>, reset: Node<'bool'>) {
    const fresh = reset.or(initialized.read().eq(0));
    const accepted = timeSeconds.gte(Math.fround(1 / sampleRate)).and(timeSeconds.lte(Math.fround(maxDelaySeconds)));
    // Accept nominal representable endpoints but never read outside physical
    // capacity. Adjacent out-of-range f32 controls are rejected without epsilon.
    const request = f64(timeSeconds).mul(sampleRate).clamp(1, maximum);
    queued.write(select(accepted, request, select(fresh, f64(1), queued.read())));
    current.write(select(fresh, queued.read(), current.read()));
    const start = remaining.read().eq(0).and(queued.read().eq(current.read()).not());
    target.write(select(fresh.or(start), queued.read(), target.read()));
    remaining.write(select(fresh, i32(0), select(start, i32(transitionSamples), remaining.read())));
    active.write(i32(remaining.read().gt(0)));
    const writeIndex = select(reset, i32(0), cursor.read());
    const available = select(reset, i32(0), valid.read());
    const at = (delay: Node<'f64'>) => {
      const whole = i32(delay.floor()), fraction = delay.sub(f64(whole));
      const relative = writeIndex.sub(whole), recentIndex = select(relative.lt(0), relative.add(size), relative);
      const olderIndex = select(recentIndex.eq(0), i32(size - 1), recentIndex.sub(1));
      const recent = select(available.gte(whole), history.read(recentIndex), f64(0));
      const older = select(available.gt(whole), history.read(olderIndex), f64(0));
      return recent.mul(f64(1).sub(fraction)).add(older.mul(fraction));
    };
    const alpha = select(active.read().gt(0), f64(i32(transitionSamples).sub(remaining.read())).div(transitionSamples - 1), f64(0));
    wet.write(at(current.read()).mul(f64(1).sub(alpha)).add(at(target.read()).mul(alpha)));
    return {
      output: f32(wet.read().div(HISTORY_SCALE)),
      timingRejected: accepted.not(),
      transitioning: active.read().gt(0),
      /** Call exactly once, after consuming output for current-sample feedback. */
      write(input: Node<'f32'>) {
        // Exact binary scaling keeps every finite f32 (including subnormals)
        // above native tiny-buffer scrubbing and far below f64 overflow.
        history.write(writeIndex, f64(input).mul(HISTORY_SCALE));
        cursor.write(writeIndex.add(1).mod(size));
        valid.write(available.add(1).min(size));
        current.write(select(remaining.read().eq(1), target.read(), current.read()));
        remaining.write(remaining.read().sub(1).max(0));
        initialized.write(1);
      },
    };
  }
  return {
    read,
    tick(input: Node<'f32'>, timeSeconds: Node<'f32'>, reset: Node<'bool'>) {
      const tap = read(timeSeconds, reset);
      tap.write(input);
      return { output: tap.output, timingRejected: tap.timingRejected, transitioning: tap.transitioning };
    },
  };
});
