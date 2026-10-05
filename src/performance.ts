import { bool, defineSubgraph, f32, f64, i32, instantiate, select, state, type MidiInputHandle, type Node } from '@unworklet/core';
import { voicePolicy, type VoicePolicyConfig } from './voice-policy.js';

export interface PitchGlideConfig { sampleRate: number }
export interface PitchGlideControls {
  /** MIDI-note semitones, clamped [-128,255]. */
  target: Node<'f32'>;
  /** [0,30] seconds; rounded to nearest sample and latched on target change. */
  seconds: Node<'f32'>;
  /** Level-sensitive: follow target immediately, consuming its current value. */
  reset: Node<'bool'>;
  /** Level-sensitive immediate target following, e.g. a nonlegato retrigger. */
  snap: Node<'bool'>;
}

// Native scalar writes flush tiny values. Scale musical pitch state so every
// finite f32 target survives; this is storage encoding, not a new noise floor.
const PITCH_SCALE = 2 ** 128;
/** Constant-time linear glide in musical pitch. Call once per sample. */
export const pitchGlide = defineSubgraph((config: PitchGlideConfig) => {
  if (!Number.isInteger(config.sampleRate) || config.sampleRate < 8000 || config.sampleRate > 192000) {
    throw new RangeError('pitchGlide sampleRate must be an integer in [8000,192000]');
  }
  const live = state.bool(false).named('live');
  const value = state.f64(0).named('valueScaled');
  const target = state.f64(0).named('targetScaled');
  const remaining = state.i32(0).named('remaining');
  return { tick(c: PitchGlideControls) {
    const destination = f64(c.target.clamp(-128, 255)).mul(PITCH_SCALE);
    const changed = destination.eq(target.read()).not();
    const immediate = c.reset.or(c.snap).or(live.read().not());
    const frames = i32(f64(c.seconds.clamp(0, 30)).mul(config.sampleRate).add(0.5).floor());
    remaining.write(select(immediate, i32(0), select(changed, frames, remaining.read())));
    const count = remaining.read();
    const output = select(immediate.or(count.lte(1)), destination,
      value.read().add(destination.sub(value.read()).div(f64(count.max(1)))));
    value.write(output);
    target.write(destination);
    remaining.write(count.sub(1).max(0));
    live.write(true);
    return f32(output.div(PITCH_SCALE));
  } };
});

export interface TuningControls {
  note: Node<'f32'>;
  transpose: Node<'f32'>;
  cents: Node<'f32'>;
  a4: Node<'f32'>;
}
/** Finite controls, bounded 12-TET conversion, one final frequency ceiling. */
export function tunedFrequency(c: TuningControls, maxFrequency: number) {
  if (!Number.isFinite(maxFrequency) || maxFrequency <= 0 || maxFrequency > 3.4028234663852886e38) {
    throw new RangeError('maxFrequency must be positive and representable as finite f32');
  }
  const semitones = f64(c.note.clamp(-128, 255)).sub(69)
    .add(f64(c.transpose.clamp(-48, 48))).add(f64(c.cents.clamp(-1200, 1200)).div(100));
  // Both pow and exp use an approximate f32 bridge in core 0.4.1.
  // |semitones| <= 257: exp(x/32), |x/32| < .465, degree 12,
  // then five squarings. The bounded remainder stays below f32 rounding.
  const x = semitones.mul(Math.LN2 / (12 * 32));
  let factorial = 1; const inverse = [1];
  for (let n = 1; n <= 12; n++) { factorial *= n; inverse.push(1 / factorial); }
  let ratio = f64(inverse[12]);
  for (let n = 11; n >= 0; n--) ratio = ratio.mul(x).add(inverse[n]);
  for (let n = 0; n < 5; n++) ratio = ratio.mul(ratio);
  return f32(f64(c.a4.clamp(220, 880)).mul(ratio).min(maxFrequency));
}

export interface PerformancePolicyConfig extends VoicePolicyConfig {
  /** Poly default/max 4; mono must be 1. */
  capacity?: number;
  /** Default/max 8; counts physically-held AND pedal-held identities. */
  heldCapacity?: number;
}

/** Native MIDI expression + bounded sustain ledger over the unchanged allocator.
 * MIDI remains quantum-boundary FIFO. All performance state is transient.
 * See docs/performance.md for duplicate, overflow, CC and DSP-clear semantics.
 */
export const performancePolicy = defineSubgraph((config: PerformancePolicyConfig) => {
  const size = config.capacity ?? (config.mode === 'mono' ? 1 : 4);
  const heldSize = config.heldCapacity ?? 8;
  if (!Number.isInteger(size) || size < 1 || size > 4) throw new RangeError('performance capacity must be an integer in [1,4]');
  if (!Number.isInteger(heldSize) || heldSize < size || heldSize > 8) throw new RangeError('performance heldCapacity must be between capacity and 8');
  const policy = instantiate(voicePolicy, { ...config, capacity: size, heldCapacity: heldSize }, { name: 'allocator' });
  const ints = (name: string, length: number) => state.buffer.i32({ size: length }).expose({ name, snapshot: 'transient' });
  const floats = (name: string, length: number) => state.buffer.f32({ size: length }).expose({ name, snapshot: 'transient' });
  // Dense ages (1..heldSize), not an ever-increasing event counter.
  const age = ints('heldAge', heldSize), key = ints('heldKey', heldSize), channel = ints('heldChannel', heldSize), down = ints('heldDown', heldSize);
  const pedal = ints('pedal', 16), bend = floats('bend', 16), pressure = floats('channelPressure', 16), timbre = floats('timbre', 16);
  const polyPressure = floats('polyPressure', size), trigger = ints('trigger', size), clear = ints('clear', size);
  const oldKey = ints('oldKey', size), oldChannel = ints('oldChannel', size), scratch = ints('scratch', 3);
  const previousIdentity = state.i32(-1).expose({ name: 'previousIdentity', snapshot: 'transient' });
  const overflow = state.bool(false).expose({ name: 'overflow', snapshot: 'transient' });
  const validChannel = (ch: Node<'i32'>) => ch.gte(0).and(ch.lte(15));
  const validKey = (note: Node<'i32'>, ch: Node<'i32'>) => validChannel(ch).and(note.gte(0)).and(note.lte(127));
  const safeChannel = (ch: Node<'i32'>) => ch.clamp(0, 15);

  function newestIdentity() {
    scratch.write(0, -1); scratch.write(1, 0);
    for (let n = 0; n < heldSize; n++) {
      const newer = age.read(n).gt(scratch.read(1));
      scratch.write(0, select(newer, i32(n), scratch.read(0)));
      scratch.write(1, select(newer, age.read(n), scratch.read(1)));
    }
  }
  function beforeChange() {
    if (config.mode === 'mono') { newestIdentity(); previousIdentity.write(scratch.read(0)); }
    policy.voices.forEach((voice, n) => { const v = voice.read(); oldKey.write(n, v.note); oldChannel.write(n, v.channel); });
  }
  function afterChange() {
    if (config.mode === 'mono') newestIdentity();
    const identityChanged = config.mode === 'mono' ? scratch.read(0).gte(0).and(scratch.read(0).eq(previousIdentity.read()).not()) : bool(false);
    policy.voices.forEach((voice, n) => {
      const v = voice.read(), retrigger = voice.takeRetrigger();
      trigger.write(n, select(retrigger, i32(1), trigger.read(n)));
      polyPressure.write(n, select(retrigger.or(identityChanged).or(v.active.not()).or(v.note.eq(oldKey.read(n)).not()).or(v.channel.eq(oldChannel.read(n)).not()), f32(0), polyPressure.read(n)));
    });
  }
  function remove(index: Node<'i32'>, when: Node<'bool'>) {
    const old = age.read(index);
    for (let n = 0; n < heldSize; n++) age.write(n, select(when.and(age.read(n).gt(old)), age.read(n).sub(1), age.read(n)));
    age.write(index, select(when, i32(0), age.read(index)));
    key.write(index, select(when, i32(0), key.read(index)));
    channel.write(index, select(when, i32(0), channel.read(index)));
    down.write(index, select(when, i32(0), down.read(index)));
  }
  function oldest(ch: Node<'i32'>, note: Node<'i32'>, physicallyDown: boolean, matchKey: boolean) {
    scratch.write(0, 0); scratch.write(1, heldSize + 1);
    for (let n = 0; n < heldSize; n++) {
      const candidate = age.read(n).gt(0).and(age.read(n).lt(scratch.read(1))).and(channel.read(n).eq(ch))
        .and(physicallyDown ? down.read(n).gt(0) : down.read(n).eq(0)).and(matchKey ? key.read(n).eq(note) : bool(true));
      scratch.write(0, select(candidate, i32(n), scratch.read(0)));
      scratch.write(1, select(candidate, age.read(n), scratch.read(1)));
    }
  }
  function noteOff(note: Node<'i32'>, ch: Node<'i32'>, when: Node<'bool'> = bool(true)) {
    oldest(ch, note, true, true);
    const index = scratch.read(0), found = when.and(validKey(note, ch)).and(scratch.read(1).lte(heldSize));
    const release = found.and(pedal.read(safeChannel(ch)).eq(0));
    down.write(index, select(found, i32(0), down.read(index)));
    policy.noteOff(select(release, note, i32(-1)), ch);
    remove(index, release);
  }
  function flush(ch: Node<'i32'>) {
    for (let n = 0; n < heldSize; n++) {
      oldest(ch, i32(0), false, false);
      const index = scratch.read(0), found = validChannel(ch).and(scratch.read(1).lte(heldSize));
      policy.noteOff(select(found, key.read(index), i32(-1)), ch);
      remove(index, found);
    }
  }
  function noteOn(note: Node<'i32'>, ch: Node<'i32'>, velocity: Node<'i32'>) {
    noteOff(note, ch, velocity.eq(0));
    scratch.write(0, 0); scratch.write(1, 0); scratch.write(2, 0);
    for (let n = heldSize - 1; n >= 0; n--) {
      const free = age.read(n).eq(0);
      scratch.write(0, select(free, i32(n), scratch.read(0)));
      scratch.write(1, select(free, i32(1), scratch.read(1)));
      scratch.write(2, scratch.read(2).add(select(free, i32(0), i32(1))));
    }
    const index = scratch.read(0), enabled = validKey(note, ch).and(velocity.gt(0)).and(velocity.lte(127));
    const accept = enabled.and(scratch.read(1).gt(0));
    overflow.write(overflow.read().or(enabled.and(accept.not())));
    age.write(index, select(accept, scratch.read(2).add(1), age.read(index)));
    key.write(index, select(accept, note, key.read(index)));
    channel.write(index, select(accept, ch, channel.read(index)));
    down.write(index, select(accept, i32(1), down.read(index)));
    policy.noteOn(select(accept, note, i32(-1)), ch, velocity);
  }
  function allSoundOff(ch: Node<'i32'>) {
    policy.voices.forEach((voice, n) => {
      const affected = voice.read().active.and(voice.read().channel.eq(ch));
      clear.write(n, select(affected, i32(1), clear.read(n)));
      trigger.write(n, select(affected, i32(0), trigger.read(n)));
    });
    policy.allSoundOff(ch);
    for (let n = 0; n < heldSize; n++) remove(i32(n), age.read(n).gt(0).and(channel.read(n).eq(ch)));
    const safe = safeChannel(ch);
    pedal.write(safe, select(validChannel(ch), i32(0), pedal.read(safe)));
  }
  function control(ch: Node<'i32'>, controller: Node<'i32'>, value: Node<'i32'>) {
    const safe = safeChannel(ch), valid = validChannel(ch).and(value.gte(0)).and(value.lte(127));
    const sustain = valid.and(controller.eq(64)), resetControllers = valid.and(controller.eq(121));
    const notesOff = valid.and(controller.eq(123)), soundOff = valid.and(controller.eq(120));
    pedal.write(safe, select(resetControllers, i32(0), select(sustain, select(value.gte(64), i32(1), i32(0)), pedal.read(safe))));
    bend.write(safe, select(resetControllers, f32(0), bend.read(safe)));
    pressure.write(safe, select(resetControllers, f32(0), pressure.read(safe)));
    timbre.write(safe, select(resetControllers, f32(0), select(valid.and(controller.eq(74)), f32(value).div(127), timbre.read(safe))));
    policy.voices.forEach((voice, n) => polyPressure.write(n, select(resetControllers.and(voice.read().channel.eq(ch)), f32(0), polyPressure.read(n))));
    for (let n = 0; n < heldSize; n++) down.write(n, select(notesOff.and(channel.read(n).eq(ch)), i32(0), down.read(n)));
    const release = resetControllers.or(sustain.and(value.lt(64))).or(notesOff.and(pedal.read(safe).eq(0)));
    flush(select(release, ch, i32(-1)));
    allSoundOff(select(soundOff, ch, i32(-1)));
  }
  function reset(when: Node<'bool'> = bool(true)) {
    policy.reset(when);
    for (let n = 0; n < heldSize; n++) {
      age.write(n, select(when, i32(0), age.read(n))); key.write(n, select(when, i32(0), key.read(n)));
      channel.write(n, select(when, i32(0), channel.read(n))); down.write(n, select(when, i32(0), down.read(n)));
    }
    for (let ch = 0; ch < 16; ch++) {
      pedal.write(ch, select(when, i32(0), pedal.read(ch))); bend.write(ch, select(when, f32(0), bend.read(ch)));
      pressure.write(ch, select(when, f32(0), pressure.read(ch))); timbre.write(ch, select(when, f32(0), timbre.read(ch)));
    }
    for (let n = 0; n < size; n++) {
      polyPressure.write(n, select(when, f32(0), polyPressure.read(n)));
      trigger.write(n, select(when, i32(0), trigger.read(n))); clear.write(n, select(when, i32(1), clear.read(n)));
    }
    overflow.write(select(when, false, overflow.read()));
  }
  return {
    capacity: size, heldCapacity: heldSize, reset,
    overflowed: () => overflow.read().or(policy.overflowed()),
    bindMidi(input: MidiInputHandle) {
      input.onEvent('noteOn', e => { beforeChange(); noteOn(e.note, e.channel, e.velocity); afterChange(); });
      input.onEvent('noteOff', e => { beforeChange(); noteOff(e.note, e.channel); afterChange(); });
      input.onEvent('cc', e => { beforeChange(); control(e.channel, e.controller, e.value); afterChange(); });
      input.onEvent('pitchBend', e => {
        const ch = safeChannel(e.channel), value = f32(e.value).sub(8192);
        bend.write(ch, select(validChannel(e.channel).and(e.value.gte(0)).and(e.value.lte(16383)), value.div(select(e.value.lt(8192), f32(8192), f32(8191))), bend.read(ch)));
      });
      input.onEvent('channelPressure', e => {
        const ch = safeChannel(e.channel);
        pressure.write(ch, select(validChannel(e.channel).and(e.pressure.gte(0)).and(e.pressure.lte(127)), f32(e.pressure).div(127), pressure.read(ch)));
      });
      input.onEvent('aftertouch', e => {
        policy.voices.forEach((voice, n) => {
          const v = voice.read(), match = v.active.and(v.channel.eq(e.channel)).and(v.note.eq(e.note)).and(e.pressure.gte(0)).and(e.pressure.lte(127));
          polyPressure.write(n, select(match, f32(e.pressure).div(127), polyPressure.read(n)));
        });
      });
    },
    voices: policy.voices.map((voice, n) => ({
      read() {
        const v = voice.read(), ch = safeChannel(v.channel);
        return { ...v, channelPressure: select(v.active, pressure.read(ch), f32(0)),
          polyPressure: select(v.active, polyPressure.read(n), f32(0)), bend: select(v.active, bend.read(ch), f32(0)),
          timbre: select(v.active, timbre.read(ch), f32(0)), sustain: v.active.and(pedal.read(ch).gt(0)) };
      },
      takeRetrigger() { const value = trigger.read(n).gt(0); trigger.write(n, 0); return value; },
      takeReset() { const value = clear.read(n).gt(0); clear.write(n, 0); return value; },
      releaseFinished(done: Node<'bool'>) { voice.releaseFinished(done); },
    })),
  };
});
