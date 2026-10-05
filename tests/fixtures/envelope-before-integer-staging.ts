// Frozen behavioral baseline from c65e2a8586eb0325cbccc3963af3764c7f15c926.
// Differential oracle only; independent expectations live in envelope.spec.ts
// and envelope-integer-staging.spec.ts. Do not update this to match production.
import { defineSubgraph, f32, f64, i32, select, state, type Node } from '@unworklet/core';

export interface EnvelopeConfig { sampleRate: number }
export interface EnvelopeControls {
  gate: Node<'bool'>;
  /** One-sample pulse; ignored when gate is false. */
  retrigger: Node<'bool'>;
  /** Reset wins over all other controls and consumes the current gate level. */
  reset: Node<'bool'>;
  attack: Node<'f32'>;
  decay: Node<'f32'>;
  sustain: Node<'f32'>;
  release: Node<'f32'>;
}

/**
 * Linear ADSR, one instance per voice/use. Call tick exactly once per sample.
 * Seconds are clamped to [0,30] and rounded to the nearest sample. Durations and
 * segment targets latch on entry (decay at the preceding attack endpoint);
 * sustain follows its input in the sustain stage.
 * A segment emits its first step on the trigger sample, reaching its endpoint on
 * step N. Zero/sub-half-sample stages collapse immediately, including A+D=0.
 * Retrigger and note-off start from the previously emitted level. Gate-off wins
 * over retrigger. Reset silences immediately; a held gate needs a new edge/pulse.
 * done is true only in idle (initial/reset) or after release reaches zero; sustain
 * at zero does not end a voice. No asymptotic tail or threshold-based termination.
 * Controls must be finite. Parameter smoothing/automation belongs to unworklet.
 */
export const envelope = defineSubgraph((config: EnvelopeConfig) => {
  if (!Number.isInteger(config.sampleRate) || config.sampleRate < 1 || config.sampleRate * 30 > 2147483646) {
    throw new RangeError('envelope sampleRate must be a positive integer with 30 seconds fitting i32 frames');
  }
  const stage = state.i32(0).named('stage'); // idle, attack, decay, sustain, release
  const level = state.f64(0).named('level');
  const previousGate = state.bool(false).named('previousGate');
  const remaining = state.i32(0).named('remaining');
  const target = state.f64(0).named('target');
  const frames = (seconds: Node<'f32'>) => i32(f64(seconds.clamp(0, 30)).mul(config.sampleRate).add(0.5).floor());

  return {
    tick(c: EnvelopeControls) {
      const on = c.gate.and(previousGate.read().not().or(c.retrigger));
      const off = c.gate.not().and(previousGate.read()).and(stage.read().eq(0).not());
      const a = frames(c.attack), d = frames(c.decay), r = frames(c.release);
      const s = f64(c.sustain.clamp(0, 1));
      const active = select(off, i32(4), select(on, i32(1), stage.read()));
      const attack = active.eq(1);
      const attackFrames = select(on, a, remaining.read());
      // Collapse zero attack into decay at this sample; a positive attack ends
      // at 1 and begins decay on the following sample.
      const decay = active.eq(2).or(attack.and(attackFrames.eq(0)));
      const enterDecay = decay.and(stage.read().eq(2).not().or(on));
      const release = active.eq(4);
      const count = select(release, select(off, r, remaining.read()),
        select(decay, select(enterDecay, d, remaining.read()), attackFrames));
      const destination = select(release, f64(0), select(decay,
        select(enterDecay, s, target.read()), f64(1)));
      const start = select(attack.and(attackFrames.eq(0)), f64(1), level.read());
      const moving = attack.or(decay).or(release);
      const last = count.lte(1).or(release.and(start.eq(0)));
      const advanced = select(last, destination,
        start.add(destination.sub(start).div(f64(count.max(1)))));
      const value = select(c.reset, f64(0), select(moving, advanced,
        select(active.eq(3), s, f64(0)))).clamp(0, 1);
      const nextStage = select(c.reset, i32(0), select(moving.and(last),
        select(release, i32(0), select(decay, i32(3), i32(2))), select(decay, i32(2), active)));
      // On a positive attack endpoint, prepare the decay without advancing it.
      const prepareDecay = attack.and(decay.not()).and(last);
      remaining.write(select(c.reset, i32(0), select(prepareDecay, d, count.sub(1).max(0))));
      target.write(select(c.reset, f64(0), select(prepareDecay, s, destination)));
      level.write(value);
      stage.write(nextStage);
      previousGate.write(c.gate);
      return { level: f32(value), done: nextStage.eq(0) };
    },
  };
});
