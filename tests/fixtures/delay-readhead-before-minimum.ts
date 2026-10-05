import { and, clamp, defineSubgraph, f32, f64, floor, i32, select, state, type Node } from '@unworklet/core';

export interface DelayReadheadConfig {
  /** Use the enclosing processor's ctx.sampleRate. */
  sampleRate: number;
  /** Fixed allocation; defaults to two seconds, not a product limit. */
  maxDelaySeconds?: number;
}

/** Mono moving readhead. Per sample, use tick or one read followed by its write. */
export const delayReadhead = defineSubgraph((config: DelayReadheadConfig) => {
  const { sampleRate, maxDelaySeconds = 2 } = config;
  const maximum = sampleRate * maxDelaySeconds;
  const size = Math.ceil(maximum) + 2;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 ||
      !Number.isFinite(maximum) || maximum < 1 || size > 0x7fffffff ||
      Math.fround(1 / sampleRate) <= 0 || !Number.isFinite(Math.fround(maxDelaySeconds))) {
    throw new RangeError('delayReadhead requires a positive finite sampleRate and capacity of at least one sample fitting i32 indexing');
  }
  const history = state.buffer.f32({ size }).expose({ name: 'history', snapshot: 'persistent' });
  const cursor = state.i32(0).named('cursor');
  const valid = state.i32(0).named('valid');
  function read(delaySeconds: Node<'f32'>, reset: Node<'bool'>) {
    // Reset invalidates history before either tap is read, without an O(size) clear.
    const write = select(reset, i32(0), cursor.read());
    const available = select(reset, i32(0), valid.read());
    const requested = f64(delaySeconds).mul(sampleRate);
    const inRange = and(delaySeconds.gte(Math.fround(1 / sampleRate)), delaySeconds.lte(Math.fround(maxDelaySeconds)));
    // NaN selects minimum; infinities saturate. Report all out-of-range controls.
    const delay = clamp(select(requested.eq(requested), requested, f64(1)), 1, maximum);
    const whole = i32(floor(delay));
    const fraction = f32(delay.sub(f64(whole)));
    const relative = write.sub(whole);
    const recentIndex = select(relative.lt(0), relative.add(size), relative);
    const olderIndex = select(recentIndex.eq(0), i32(size - 1), recentIndex.sub(1));
    const recent = select(available.gte(whole), history.read(recentIndex), f32(0));
    const older = select(available.gt(whole), history.read(olderIndex), f32(0));
    const output = recent.mul(f32(1).sub(fraction)).add(older.mul(fraction));
    return {
      output,
      outOfRange: inRange.not(),
      // This closure runs at graph construction, never on the audio thread.
      // Consume exactly once, after using output to construct the current input.
      write(input: Node<'f32'>) {
        history.write(write, input);
        cursor.write(write.add(1).mod(size));
        valid.write(select(available.lt(size), available.add(1), i32(size)));
      },
    };
  }
  return {
    read,
    tick(input: Node<'f32'>, delaySeconds: Node<'f32'>, reset: Node<'bool'>) {
      const tap = read(delaySeconds, reset);
      tap.write(input);
      return { output: tap.output, outOfRange: tap.outOfRange };
    },
  };
});
