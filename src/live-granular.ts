import { defineSubgraph, f32, f64, i32, select, state, type Node } from '@unworklet/core';
import type { LiveSampleBuffer } from './live-buffer.js';

export interface LiveGranularConfig {
  /** Shared accepted-write history; its sampleRate must match the processor. */
  history: LiveSampleBuffer;
  /** Immutable first-free pool size, integer 1..8. */
  maxGrains: number;
}
export interface LiveGranularControls {
  /** Exactly the immediately preceding history.tick() status.written. */
  written: Node<'bool'>;
  /** The same reset passed to history.tick(); level-sensitive, highest priority. */
  reset: Node<'bool'>;
  /** One request per true sample; held true requests every sample. */
  trigger: Node<'bool'>;
  /** Onset age after the current write, in retained accepted-write frames. */
  ageFrames: Node<'f32'>;
  /** Signed frames toward newer source material per output sample, [-16,16]. */
  rate: Node<'f32'>;
  /** [0,2] seconds, rounded to frames with minimum 3. Zero is valid. */
  durationSeconds: Node<'f32'>;
}
export interface LiveGranularResult {
  output: Node<'f32'>;
  /** Valid reads this sample, including both zero-weight window endpoints. */
  activeGrains: Node<'i32'>;
  launched: Node<'bool'>;
  /** Valid request with a full pool; no stealing or queue. */
  dropped: Node<'bool'>;
  /** Invalid controls or unavailable onset. Does not interrupt existing grains. */
  rejected: Node<'bool'>;
  /** Existing grains whose current read became unavailable; excludes reset/EOF. */
  expiredGrains: Node<'i32'>;
}
export interface LiveGranularSource {
  tick(controls: LiveGranularControls): LiveGranularResult;
}

// Preserve small representable scalar values across core 0.4.1's 1e-30
// state-store floor. This does not extend f64 precision at a large cursor.
const SCALE = 2 ** 192;

/** Fixed mono live-history grain reader. Call the writer, then this reader once
 * per sample with the writer's written flag and shared reset. No density clock,
 * source ownership, resampling filter, implicit safety margin or host ingress. */
export const liveGranularSource = defineSubgraph((config: LiveGranularConfig): LiveGranularSource => {
  const { history, maxGrains } = config;
  if (!Number.isInteger(maxGrains) || maxGrains < 1 || maxGrains > 8) throw new RangeError('liveGranularSource maxGrains must be an integer in [1,8]');
  if (!Number.isInteger(history.capacity) || history.capacity < 1 || history.capacity > 65536 || !Number.isFinite(history.sampleRate) || history.sampleRate < 8000 || history.sampleRate > 192000) throw new RangeError('liveGranularSource history requires capacity [1,65536] and sampleRate [8000,192000]');
  const allocated = state.bool(false).expose({ name: 'allocated', snapshot: 'transient' });
  const grains = Array.from({ length: maxGrains }, (_, n) => ({
    active: state.bool(false).named(`grain${n}Active`),
    index: state.i32(0).named(`grain${n}Index`),
    duration: state.i32(3).named(`grain${n}Duration`),
    age: state.f64(0).named(`grain${n}AgeScaled`),
    rate: state.f64(0).named(`grain${n}RateScaled`),
  }));
  return { tick(c) {
    const requested = c.trigger.and(c.reset.not());
    const valid = c.ageFrames.gte(0).and(c.ageFrames.lte(history.capacity - 1))
      .and(f64(c.ageFrames).lte(f64(history.length().sub(1))))
      .and(c.rate.gte(-16)).and(c.rate.lte(16))
      .and(c.durationSeconds.gte(0)).and(c.durationSeconds.lte(2));
    const attempt = requested.and(valid);
    // select is eager. Sanitize before conversion even on rejected requests.
    const duration = i32(f64(select(valid, c.durationSeconds, f32(0))).mul(history.sampleRate).add(.5).floor()).clamp(3, Math.round(2 * history.sampleRate));
    const onsetAge = f64(select(valid, c.ageFrames, f32(0))), onsetRate = f64(select(valid, c.rate, f32(0)));
    allocated.write(false);
    let sum = f64(0), count = i32(0), expired = i32(0);
    for (const grain of grains) {
      const activeBefore = grain.active.read().and(c.reset.not());
      // Add the increment as one expression: (tinyAge + 1) - 1 would erase
      // representable tiny onset fractions while continuously writing at rate 1.
      const increment = select(c.written, f64(1), f64(0)).sub(grain.rate.read().div(SCALE));
      const currentAge = grain.age.read().div(SCALE).add(increment);
      const available = currentAge.gte(0).and(currentAge.lte(f64(history.length().sub(1))));
      const existing = activeBefore.and(available);
      expired = expired.add(select(activeBefore.and(available.not()), i32(1), i32(0)));
      const alreadyAllocated = allocated.read();
      const launch = attempt.and(alreadyAllocated.not()).and(existing.not());
      allocated.write(alreadyAllocated.or(launch));
      const active = existing.or(launch);
      grain.index.write(select(c.reset.or(launch), i32(0), grain.index.read()));
      grain.duration.write(select(c.reset, i32(3), select(launch, duration, grain.duration.read())));
      grain.rate.write(select(c.reset, f64(0), select(launch, onsetRate.mul(SCALE), grain.rate.read())));
      grain.age.write(select(active, select(launch, onsetAge, currentAge).mul(SCALE), f64(0)));
      const index = grain.index.read(), length = grain.duration.read();
      const window = f64(1).sub(f64(index).mul(2).div(f64(length.sub(1))).sub(1).abs()).max(0);
      const read = history.readAge(grain.age.read().div(SCALE));
      sum = sum.add(select(active, f64(read.output).mul(window), f64(0)));
      count = count.add(select(active, i32(1), i32(0)));
      grain.index.write(select(active, index.add(1), i32(0)));
      // Natural completion is recorded now, before next sample's age validity.
      grain.active.write(active.and(index.add(1).lt(length)));
    }
    const launched = allocated.read();
    return { output: f32(sum.div(maxGrains)), activeGrains: count, launched,
      dropped: attempt.and(launched.not()), rejected: requested.and(valid.not()), expiredGrains: expired };
  } };
});
