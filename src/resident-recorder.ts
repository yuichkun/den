import { defineSubgraph, f32, f64, i32, select, state, type Node } from '@unworklet/core';
import type { ResidentSample } from './sample.js';

export interface ResidentTakeRecorderConfig {
  /** Mono take capacity, 1..65,536 frames. Separate fixed load/record buffers. */
  capacity: number;
  /** Rate of the incoming signal/processor, 8,000..192,000 Hz. No resampling. */
  sampleRate: number;
}
export interface ResidentTakeRecorderControls {
  input: Node<'f32'>;
  /** Append one frame per tick; false pauses. Capacity stops recording without wrapping. */
  record: Node<'bool'>;
  /** Level-sensitive logical clear, with priority over record. Not secure erasure. */
  reset: Node<'bool'>;
}
export interface ResidentTakeRecorder {
  /** Existing resident reader/load contract. Load replaces the take; later recording appends. */
  readonly sample: ResidentSample;
  tick(controls: ResidentTakeRecorderControls): {
    written: Node<'bool'>;
    full: Node<'bool'>;
    length: Node<'i32'>;
  };
}

const READ_POSITION_SCALE = 2 ** 192;
const PCM_SCALE = 2 ** 128;
const F32_MAX = 3.4028234663852886e38;

/** Native finite take/pause/resume writer for catalog §3. Exact binary scaling
 * retains finite f32 input below core's scalar-store floor. No overdub, circular
 * overwrite, gain, device input, transport, or realtime guarantee. */
export const residentTakeRecorder = defineSubgraph((config: ResidentTakeRecorderConfig): ResidentTakeRecorder => {
  const { capacity, sampleRate } = config;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65536) throw new RangeError('take capacity must be an integer in [1,65536]');
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('sampleRate must be in [8000,192000] Hz');
  // Event ingress keeps its original f32 bytes; appended PCM is scaled into
  // f64 so even the smallest nonzero f32 survives core's 1e-30 store floor.
  // One boundary chooses the loaded prefix or recorded suffix. No conversion
  // loop/copy or additional runtime is required when replacing a take.
  const loadedPCM = state.buffer.f32({ size: capacity }).expose({ name: 'loadedPCM', snapshot: 'persistent' });
  const recordedPCM = state.buffer.f64({ size: capacity + 1 }).expose({ name: 'recordedPCM', snapshot: 'persistent' });
  const length = state.i32(0).named('length'), revision = state.i32(0).named('revision');
  const loadedPrefixLength = state.i32(0).named('loadedPrefixLength');
  const readPosition = state.f64(0).expose({ name: 'readPosition', snapshot: 'transient' });
  const sample: ResidentSample = {
    capacity, sourceSampleRate: sampleRate,
    load(data) {
      loadedPCM.copyFrom(data);
      length.write(data.length.clamp(0, capacity));
      loadedPrefixLength.write(data.length.clamp(0, capacity));
      revision.write(revision.read().add(1));
    },
    length() { return length.read(); },
    revision() { return revision.read(); },
    // Match residentSample's published interpolation, clipping and invalid-tap
    // policy without changing the existing module or consumer interfaces.
    read(position, start, end, loop) {
      const lo = start.clamp(0, capacity - 1), hi = end.clamp(0, capacity).min(length.read());
      const valid = hi.gt(lo);
      const safe = select(position.eq(position), position, f64(lo)).clamp(-2147483648, 2147483647);
      const span = f64(hi.sub(lo).max(1)), relative = safe.sub(f64(lo));
      const wrapped = relative.sub(relative.div(span).floor().mul(span)).add(f64(lo));
      readPosition.write((loop ? wrapped : safe.clamp(f64(lo), f64(hi.sub(1).max(lo)))).mul(READ_POSITION_SCALE));
      const p = readPosition.read().div(READ_POSITION_SCALE);
      const whole = i32(p.floor()).clamp(0, capacity - 1), fraction = p.sub(f64(whole));
      const next = loop ? select(whole.add(1).gte(hi), lo, whole.add(1)) : whole.add(1).min(hi.sub(1).max(lo));
      const second = next.clamp(0, capacity - 1), prefix = loadedPrefixLength.read();
      const rawA = select(whole.lt(prefix), f64(loadedPCM.read(whole)), recordedPCM.read(whole).div(PCM_SCALE));
      const rawB = select(second.lt(prefix), f64(loadedPCM.read(second)), recordedPCM.read(second).div(PCM_SCALE));
      const a = select(rawA.eq(rawA).and(rawA.abs().lte(F32_MAX)), rawA, f64(0));
      const b = select(rawB.eq(rawB).and(rawB.abs().lte(F32_MAX)), rawB, f64(0));
      return select(valid, f32(a.add(b.sub(a).mul(fraction))), f32(0));
    },
  };
  return { sample, tick(c) {
    const before = length.read();
    const written = c.record.and(c.reset.not()).and(before.lt(capacity));
    const index = select(written, before, i32(capacity));
    const finite = c.input.eq(c.input).and(c.input.abs().lte(F32_MAX));
    // select evaluates both branches. Inactive writes touch only a private
    // sentinel, never existing exposed PCM. Signed zero stores as positive zero.
    recordedPCM.write(index, select(written.and(finite), f64(c.input).mul(PCM_SCALE), f64(0)));
    // Commit bytes before making the additional frame visible to a later reader.
    length.write(select(c.reset, i32(0), before.add(select(written, i32(1), i32(0)))));
    loadedPrefixLength.write(select(c.reset, i32(0), loadedPrefixLength.read()));
    revision.write(revision.read().add(select(c.reset, i32(1), i32(0))));
    const current = length.read();
    return { written, full: current.eq(capacity), length: current };
  } };
});
