import { bool, defineSubgraph, f32, i32, select, state, type MidiInputHandle, type Node } from '@unworklet/core';

/** Fixed construction capacities, not product-wide polyphony limits. */
export interface VoicePolicyConfig {
  mode: 'mono' | 'poly';
  /** Poly default 16; mono must use one slot. Maximum 32 limits graph expansion. */
  capacity?: number;
  /** Held note-on identities (including stolen notes). Default 128, maximum 256. */
  heldCapacity?: number;
  /** Mono only: preserve gate without a retrigger when another held note takes priority. */
  legato?: boolean;
}

function capacity(value: number, maximum: number, name: string) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer in [1, ${maximum}]`);
  }
  return value;
}

/** Voice allocation only. MIDI transport, graph storage, and node control remain unworklet's. */
export const voicePolicy = defineSubgraph((config: VoicePolicyConfig) => {
  if (config.mode !== 'mono' && config.mode !== 'poly') throw new TypeError('mode must be mono or poly');
  const size = capacity(config.capacity ?? (config.mode === 'mono' ? 1 : 16), 32, 'capacity');
  const heldSize = capacity(config.heldCapacity ?? Math.max(128, size), 256, 'heldCapacity');
  if (config.mode === 'mono' && size !== 1) throw new RangeError('mono capacity must be 1');
  if (heldSize < size) throw new RangeError('heldCapacity must be at least capacity');
  if (config.legato !== undefined && typeof config.legato !== 'boolean') throw new TypeError('legato must be boolean');
  const legato = config.legato ?? true;
  const ints = (name: string, length: number) => state.buffer.i32({ size: length }).expose({ name, snapshot: 'transient' });
  const note = ints('note', size);
  const channel = ints('channel', size);
  const velocity = state.buffer.f32({ size }).expose({ name: 'velocity', snapshot: 'transient' });
  const age = ints('age', size); // zero means free, otherwise dense allocation order 1..size
  const releaseAge = ints('releaseAge', size); // zero means held, otherwise release order
  const owner = ints('owner', size); // held token 1..heldSize; zero means no key owns the release tail
  const retrigger = ints('retrigger', size);
  const heldNote = ints('heldNote', heldSize + 1);
  const heldChannel = ints('heldChannel', heldSize + 1);
  const heldVelocity = ints('heldVelocity', heldSize + 1);
  // Intrusive held-key order: token 0 is a sentinel; valid tokens are 1..heldSize.
  const occupied = ints('occupied', heldSize + 1);
  const previous = ints('previous', heldSize + 1);
  const next = ints('next', heldSize + 1);
  const head = state.i32(0).expose({ name: 'head', snapshot: 'transient' });
  const tail = state.i32(0).expose({ name: 'tail', snapshot: 'transient' });
  // Materialize loop accumulators: unworklet 0.4.1 analysis recursively expands
  // expression DAGs, so nested selects otherwise grow exponentially.
  const scratch = ints('scratch', 4);
  const overflow = state.bool(false).expose({ name: 'overflow', snapshot: 'transient' });

  const validKey = (key: Node<'i32'>, ch: Node<'i32'>) => key.gte(0).and(key.lte(127)).and(ch.gte(0)).and(ch.lte(15));
  const releaseCount = () => {
    let count = i32(0);
    for (let n = 0; n < size; n++) count = count.add(select(releaseAge.read(n).gt(0), i32(1), i32(0)));
    return count;
  };

  function releaseVoice(index: number, when: Node<'bool'>) {
    const shouldRelease = when.and(age.read(index).gt(0)).and(owner.read(index).gt(0));
    const nextOrder = releaseCount().add(1);
    owner.write(index, select(shouldRelease, i32(0), owner.read(index)));
    releaseAge.write(index, select(shouldRelease, nextOrder, releaseAge.read(index)));
  }

  function freeVoice(index: number, when: Node<'bool'>) {
    const oldAge = age.read(index);
    const oldRelease = releaseAge.read(index);
    const enabled = when.and(oldAge.gt(0));
    for (let n = 0; n < size; n++) {
      const a = age.read(n);
      const r = releaseAge.read(n);
      age.write(n, select(enabled.and(a.gt(oldAge)), a.sub(1), a));
      releaseAge.write(n, select(enabled.and(oldRelease.gt(0)).and(r.gt(oldRelease)), r.sub(1), r));
    }
    age.write(index, select(enabled, i32(0), age.read(index)));
    releaseAge.write(index, select(enabled, i32(0), releaseAge.read(index)));
    owner.write(index, select(enabled, i32(0), owner.read(index)));
    note.write(index, select(enabled, i32(0), note.read(index)));
    channel.write(index, select(enabled, i32(0), channel.read(index)));
    velocity.write(index, select(enabled, f32(0), velocity.read(index)));
    retrigger.write(index, select(enabled, i32(0), retrigger.read(index)));
  }

  function activate(index: Node<'i32'>, token: Node<'i32'>, when: Node<'bool'>, trigger: Node<'bool'>) {
    const oldAge = age.read(index);
    const oldRelease = releaseAge.read(index);
    let count = i32(0);
    for (let n = 0; n < size; n++) count = count.add(select(age.read(n).gt(0), i32(1), i32(0)));
    for (let n = 0; n < size; n++) {
      const a = age.read(n);
      const r = releaseAge.read(n);
      age.write(n, select(when.and(oldAge.gt(0)).and(a.gt(oldAge)), a.sub(1), a));
      releaseAge.write(n, select(when.and(oldRelease.gt(0)).and(r.gt(oldRelease)), r.sub(1), r));
    }
    age.write(index, select(when, select(oldAge.gt(0), count, count.add(1)), age.read(index)));
    releaseAge.write(index, select(when, i32(0), releaseAge.read(index)));
    owner.write(index, select(when, token, owner.read(index)));
    note.write(index, select(when, heldNote.read(token), note.read(index)));
    channel.write(index, select(when, heldChannel.read(token), channel.read(index)));
    velocity.write(index, select(when, f32(heldVelocity.read(token)).div(127), velocity.read(index)));
    retrigger.write(index, select(when.and(trigger), i32(1), retrigger.read(index)));
  }

  function monoPriority(when: Node<'bool'>) {
    const selected = tail.read();
    const newest = selected;
    const changed = owner.read(0).eq(selected).not();
    const trigger = bool(!legato).or(owner.read(0).eq(0));
    activate(i32(0), selected, when.and(newest.gt(0)).and(changed), trigger);
    releaseVoice(0, when.and(newest.eq(0)));
  }

  function removeHeld(token: Node<'i32'>, when: Node<'bool'>) {
    const before = previous.read(token);
    const after = next.read(token);
    next.write(before, select(when.and(before.gt(0)), after, next.read(before)));
    previous.write(after, select(when.and(after.gt(0)), before, previous.read(after)));
    head.write(select(when.and(head.read().eq(token)), after, head.read()));
    tail.write(select(when.and(tail.read().eq(token)), before, tail.read()));
    occupied.write(token, select(when, i32(0), occupied.read(token)));
    previous.write(token, select(when, i32(0), previous.read(token)));
    next.write(token, select(when, i32(0), next.read(token)));
    heldNote.write(token, select(when, i32(0), heldNote.read(token)));
    heldChannel.write(token, select(when, i32(0), heldChannel.read(token)));
    heldVelocity.write(token, select(when, i32(0), heldVelocity.read(token)));
  }

  function noteOff(key: Node<'i32'>, ch: Node<'i32'>, when: Node<'bool'> = bool(true)) {
    scratch.write(0, 0);
    scratch.write(1, head.read());
    for (let n = 0; n < heldSize; n++) {
      const token = scratch.read(0);
      const cursor = scratch.read(1);
      const match = token.eq(0).and(cursor.gt(0)).and(heldNote.read(cursor).eq(key)).and(heldChannel.read(cursor).eq(ch));
      scratch.write(0, select(match, cursor, token));
      scratch.write(1, next.read(cursor));
    }
    const token = scratch.read(0);
    const found = when.and(validKey(key, ch)).and(token.gt(0));
    removeHeld(token, found);
    if (config.mode === 'mono') monoPriority(found);
    else for (let n = 0; n < size; n++) releaseVoice(n, found.and(owner.read(n).eq(token)));
  }

  function noteOn(key: Node<'i32'>, ch: Node<'i32'>, vel: Node<'i32'>) {
    noteOff(key, ch, vel.eq(0));
    const enabled = validKey(key, ch).and(vel.gt(0)).and(vel.lte(127));
    let token = i32(0);
    let found = bool(false);
    for (let n = heldSize; n >= 1; n--) {
      const free = occupied.read(n).eq(0);
      token = select(free, i32(n), token);
      found = found.or(free);
    }
    const accept = enabled.and(found);
    overflow.write(overflow.read().or(enabled.and(found.not())));
    const last = tail.read();
    next.write(last, select(accept.and(last.gt(0)), token, next.read(last)));
    previous.write(token, select(accept, last, previous.read(token)));
    next.write(token, select(accept, i32(0), next.read(token)));
    head.write(select(accept.and(last.eq(0)), token, head.read()));
    tail.write(select(accept, token, tail.read()));
    occupied.write(token, select(accept, i32(1), occupied.read(token)));
    heldNote.write(token, select(accept, key, heldNote.read(token)));
    heldChannel.write(token, select(accept, ch, heldChannel.read(token)));
    heldVelocity.write(token, select(accept, vel, heldVelocity.read(token)));
    if (config.mode === 'mono') monoPriority(accept);
    else {
      scratch.write(2, 2 * size + 1);
      scratch.write(3, 0);
      for (let n = 0; n < size; n++) {
        const a = age.read(n);
        const r = releaseAge.read(n);
        const score = select(a.eq(0), i32(0), select(r.gt(0), r, a.add(size)));
        const best = scratch.read(2);
        const chosen = scratch.read(3);
        const better = score.lt(best); // ascending slots break ties deterministically
        scratch.write(3, select(better, i32(n), chosen));
        scratch.write(2, select(better, score, best));
      }
      activate(scratch.read(3), token, accept, bool(true));
    }
  }

  function channelOff(ch: Node<'i32'>, immediate: boolean, when: Node<'bool'> = bool(true)) {
    const enabled = when.and(ch.gte(0)).and(ch.lte(15));
    // Remove matching identities through bounded, constant-time list unlinking.
    for (let n = 1; n <= heldSize; n++) {
      removeHeld(i32(n), enabled.and(occupied.read(n).gt(0)).and(heldChannel.read(n).eq(ch)));
    }
    if (immediate) for (let n = 0; n < size; n++) freeVoice(n, enabled.and(channel.read(n).eq(ch)));
    if (config.mode === 'mono') monoPriority(enabled);
    else if (!immediate) for (let n = 0; n < size; n++) releaseVoice(n, enabled.and(channel.read(n).eq(ch)));
  }

  function reset(when: Node<'bool'> = bool(true)) {
    for (let n = 0; n < size; n++) freeVoice(n, when);
    for (let n = 0; n <= heldSize; n++) {
      occupied.write(n, select(when, i32(0), occupied.read(n)));
      previous.write(n, select(when, i32(0), previous.read(n)));
      next.write(n, select(when, i32(0), next.read(n)));
      heldNote.write(n, select(when, i32(0), heldNote.read(n)));
      heldChannel.write(n, select(when, i32(0), heldChannel.read(n)));
      heldVelocity.write(n, select(when, i32(0), heldVelocity.read(n)));
    }
    head.write(select(when, i32(0), head.read()));
    tail.write(select(when, i32(0), tail.read()));
    overflow.write(select(when, false, overflow.read()));
  }

  return {
    capacity: size,
    heldCapacity: heldSize,
    noteOn,
    noteOff,
    reset,
    allNotesOff: (ch: Node<'i32'>) => channelOff(ch, false),
    allSoundOff: (ch: Node<'i32'>) => channelOff(ch, true),
    overflowed: () => overflow.read(),
    /** Call once in declaration scope with an existing unworklet MIDI input. */
    bindMidi(input: MidiInputHandle) {
      input.onEvent('noteOn', e => noteOn(e.note, e.channel, e.velocity));
      input.onEvent('noteOff', e => noteOff(e.note, e.channel));
      input.onEvent('cc', e => {
        channelOff(e.channel, false, e.controller.eq(123));
        channelOff(e.channel, true, e.controller.eq(120));
      });
    },
    voices: Array.from({ length: size }, (_, index) => ({
      read() {
        const active = age.read(index).gt(0);
        return {
          active,
          gate: owner.read(index).gt(0),
          note: select(active, note.read(index), i32(-1)),
          channel: select(active, channel.read(index), i32(-1)),
          velocity: velocity.read(index),
        };
      },
      /** One latched start/retrigger; read once per sample before invoking the envelope. */
      takeRetrigger() {
        const value = retrigger.read(index).gt(0);
        retrigger.write(index, 0);
        return value;
      },
      /** Envelope completion may free only a released voice, never a newly held one. */
      releaseFinished(done: Node<'bool'>) {
        freeVoice(index, done.and(owner.read(index).eq(0)));
      },
    })),
  };
});
