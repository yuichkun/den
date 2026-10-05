import { bool, defineSubgraph, f32, f64, i32, select, state, type MidiInputHandle, type Node } from '@unworklet/core';

export interface MpeExpressionConfig {
  /** Fixed lower zone: native channel 0 is master, 1..memberChannels are members. Default 15. */
  memberChannels?: number;
  /** Symmetric semitone range, finite [0,96]. Default 48. No RPN negotiation. */
  memberBendRange?: number;
  /** Symmetric semitone range, finite [0,96]. Default 2. */
  masterBendRange?: number;
}

/** Pass the existing allocator voice's active/channel fields without remapping. */
export interface MpeExpressionVoice {
  active: Node<'bool'>;
  channel: Node<'i32'>;
}

/** Lower-zone expression routing only: no note allocator or pedal propagation.
 * Bind once to the same native MIDI input as the existing allocation policy.
 * See docs/mpe-expression.md for channel reuse, reset and unsupported features.
 */
export const mpeExpression = defineSubgraph((config: MpeExpressionConfig) => {
  const members = config.memberChannels ?? 15;
  const memberRange = config.memberBendRange ?? 48;
  const masterRange = config.masterBendRange ?? 2;
  if (!Number.isInteger(members) || members < 1 || members > 15) {
    throw new RangeError('mpeExpression memberChannels must be an integer in [1,15]');
  }
  for (const [name, value] of [['memberBendRange', memberRange], ['masterBendRange', masterRange]] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 96) throw new RangeError(`mpeExpression ${name} must be finite in [0,96]`);
  }
  const ints = (name: string) => state.buffer.i32({ size: members + 1 }).expose({ name, snapshot: 'transient' });
  // Store centered integer MIDI values, so fresh-instance transient defaults
  // represent bend 8192, pressure 0 and CC74 64. In-place restore leaves
  // transient state unchanged; reset() is the explicit clearing operation.
  const bend = ints('bend'), pressure = ints('pressure'), timbre = ints('timbre');
  const validChannel = (channel: Node<'i32'>) => channel.gte(0).and(channel.lte(members));
  const valid7 = (value: Node<'i32'>) => value.gte(0).and(value.lte(127));
  const normalizedBend = (channel: Node<'i32'>) => {
    const value = bend.read(channel);
    return f64(value).div(select(value.lt(0), f64(8192), f64(8191)));
  };
  function reset(when: Node<'bool'> = bool(true)) {
    for (let channel = 0; channel <= members; channel++) {
      bend.write(channel, select(when, i32(0), bend.read(channel)));
      pressure.write(channel, select(when, i32(0), pressure.read(channel)));
      timbre.write(channel, select(when, i32(0), timbre.read(channel)));
    }
  }
  return {
    memberChannels: members, memberBendRange: memberRange, masterBendRange: masterRange,
    reset,
    bindMidi(input: MidiInputHandle) {
      input.onEvent('pitchBend', e => {
        const channel = e.channel.clamp(0, members);
        const valid = validChannel(e.channel).and(e.value.gte(0)).and(e.value.lte(16383));
        bend.write(channel, select(valid, e.value.sub(8192), bend.read(channel)));
      });
      input.onEvent('channelPressure', e => {
        const channel = e.channel.clamp(0, members);
        pressure.write(channel, select(validChannel(e.channel).and(valid7(e.pressure)), e.pressure, pressure.read(channel)));
      });
      input.onEvent('cc', e => {
        const channel = e.channel.clamp(0, members), valid = validChannel(e.channel).and(valid7(e.value));
        const clear = valid.and(e.controller.eq(121));
        bend.write(channel, select(clear, i32(0), bend.read(channel)));
        pressure.write(channel, select(clear, i32(0), pressure.read(channel)));
        timbre.write(channel, select(clear, i32(0), select(valid.and(e.controller.eq(74)), e.value.sub(64), timbre.read(channel))));
      });
    },
    read(voice: MpeExpressionVoice) {
      const inZone = voice.active.and(voice.channel.gte(1)).and(voice.channel.lte(members));
      const channel = voice.channel.clamp(1, members);
      const member = normalizedBend(channel), master = normalizedBend(i32(0));
      const lane = (value: Node<'f32'>) => select(inZone, value, f32(0));
      return {
        inZone,
        memberBend: lane(f32(member)), masterBend: lane(f32(master)),
        /** Already includes both bend ranges. Do not add performancePolicy.bend again. */
        bendSemitones: lane(f32(member.mul(memberRange).add(master.mul(masterRange)))),
        memberPressure: lane(f32(pressure.read(channel)).div(127)),
        masterPressure: lane(f32(pressure.read(0)).div(127)),
        memberTimbre: lane(f32(timbre.read(channel).add(64)).div(127)),
        masterTimbre: lane(f32(timbre.read(0).add(64)).div(127)),
      };
    },
  };
});
