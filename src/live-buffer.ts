import { defineSubgraph, f32, f64, i32, select, state, type Node } from '@unworklet/core';

export interface LiveSampleBufferConfig {
  /** Fixed mono history capacity, 1..65,536 accepted writes. */
  capacity: number;
  /** Incoming processor rate, 8,000..192,000 Hz. No resampling. */
  sampleRate: number;
}
export interface LiveSampleBufferControls {
  input: Node<'f32'>;
  /** Accept one frame per tick. False freezes history, including its ages. */
  record: Node<'bool'>;
  /** Level-sensitive logical clear, with priority over record. Not secure erasure. */
  reset: Node<'bool'>;
}
export interface LiveSampleBufferRead {
  output: Node<'f32'>;
  /** True only for finite age in [0,length-1], including both interpolation taps. */
  available: Node<'bool'>;
}
export interface LiveSampleBufferStatus {
  written: Node<'bool'>;
  full: Node<'bool'>;
  length: Node<'i32'>;
}
export interface LiveSampleBuffer {
  readonly capacity: number;
  readonly sampleRate: number;
  tick(controls: LiveSampleBufferControls): LiveSampleBufferStatus;
  /** Age 0 is the latest accepted write at this statement position. Linear
   * interpolation toward older writes; unavailable ages are silent, not wrapped. */
  readAge(ageFrames: Node<'f64'>): LiveSampleBufferRead;
  length(): Node<'i32'>;
  /** Wrapping i32 mutation serial: one increment per accepted write or reset. */
  revision(): Node<'i32'>;
}

const PCM_SCALE = 2 ** 128;
const AGE_SCALE = 2 ** 192;
const F32_MAX = 3.4028234663852886e38;

/** Bounded rolling mono history with explicit accepted-write ages. Intentionally
 * not a ResidentSample: rotating age coordinates must not silently change the
 * meaning of existing sample-player/grain positions. No device or host ingress. */
export const liveSampleBuffer = defineSubgraph((config: LiveSampleBufferConfig): LiveSampleBuffer => {
  const { capacity, sampleRate } = config;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65536) throw new RangeError('live buffer capacity must be an integer in [1,65536]');
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('sampleRate must be in [8000,192000] Hz');
  // Exact binary scaling preserves every finite f32, including subnormals,
  // across core 0.4.1's 1e-30 scalar-store floor. The extra cell is private.
  const pcm = state.buffer.f64({ size: capacity + 1 }).expose({ name: 'pcm', snapshot: 'persistent' });
  const head = state.i32(0).named('head'), length = state.i32(0).named('length');
  const revision = state.i32(0).named('revision');
  const readAge = state.f64(0).expose({ name: 'readAge', snapshot: 'transient' });
  return {
    capacity, sampleRate,
    tick(c) {
      const written = c.record.and(c.reset.not());
      const finite = c.input.eq(c.input).and(c.input.abs().lte(F32_MAX));
      // select evaluates both branches. Paused/reset ticks touch the sentinel,
      // not exposed history, and no clearing pass runs on reset.
      pcm.write(select(written, head.read(), i32(capacity)), select(written.and(finite), f64(c.input).mul(PCM_SCALE), f64(0)));
      head.write(select(c.reset, i32(0), select(written, head.read().add(1).mod(capacity), head.read())));
      length.write(select(c.reset, i32(0), length.read().add(select(written, i32(1), i32(0))).min(capacity)));
      revision.write(revision.read().add(select(written.or(c.reset), i32(1), i32(0))));
      const current = length.read();
      return { written, full: current.eq(capacity), length: current };
    },
    readAge(ageFrames) {
      const count = length.read();
      const available = ageFrames.gte(0).and(ageFrames.lte(f64(count.sub(1))));
      // Keep invalid ages out of integer conversion and address arithmetic.
      // Scale the cache before its native store so tiny valid fractions still
      // contribute when adjacent samples span the full finite f32 range.
      readAge.write(select(available, ageFrames, f64(0)).mul(AGE_SCALE));
      const age = readAge.read().div(AGE_SCALE), whole = i32(age.floor());
      const fraction = age.sub(f64(whole));
      const older = whole.add(1).min(count.sub(1).max(0));
      const newest = head.read().add(capacity - 1);
      const a = pcm.read(newest.sub(whole).mod(capacity)).div(PCM_SCALE);
      const b = pcm.read(newest.sub(older).mod(capacity)).div(PCM_SCALE);
      return { output: select(available, f32(a.add(b.sub(a).mul(fraction))), f32(0)), available };
    },
    length() { return length.read(); },
    revision() { return revision.read(); },
  };
});
