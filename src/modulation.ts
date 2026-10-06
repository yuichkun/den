import { bool, defineSubgraph, f32, f64, i32, instantiate, select, state, type MidiOutputHandle, type Node } from '@unworklet/core';

export type ClockMode = 'free' | 'tempo';
export interface MusicalClockConfig {
  sampleRate: number;
  mode: ClockMode;
  /** Fixed cycle length, 1..64 steps. */
  steps: number;
  /** Tempo mode only: power of two in [1/64,64], default 1. */
  stepsPerBeat?: number;
}
export interface MusicalClockControls {
  /** Free mode: steps/second. Tempo mode: BPM. Clamped to [0,1000]. */
  rate: Node<'f32'>;
  /** Hold at step/phase zero with no tick. First reset-low sample ticks. */
  reset: Node<'bool'>;
  /** Rising edge seeks; held high does not pin or retrigger. Reset consumes it. */
  seek: Node<'bool'>;
  /** Steps, clamped to +/-1048576 then wrapped into the fixed cycle. */
  position: Node<'f32'>;
}
export interface MusicalClockOutput {
  step: Node<'f32'>;
  /** Fraction of the current step, in [0,1). */
  phase: Node<'f32'>;
  /** Initial sample, reset release, seek edge, or a step boundary. */
  tick: Node<'bool'>;
}
export interface SequenceStep { value: number; gate: number }
export interface StepSequenceConfig extends Omit<MusicalClockConfig, 'steps'> {
  /** Fixed 1..64 steps; values [-1,1], gate fractions [0,1]. */
  steps: readonly SequenceStep[];
}
export interface StepSequenceOutput extends MusicalClockOutput { value: Node<'f32'>; gate: Node<'bool'> }
export type MsegCurve = 'linear' | 'easeIn' | 'easeOut' | 'smoothstep';
export interface MsegSegment { seconds: number; target: number; curve: MsegCurve }
export interface MsegConfig {
  sampleRate: number;
  initial: number;
  /** Fixed 1..16 segments; durations [0,30] s, targets [-1,1]. */
  segments: readonly MsegSegment[];
  /** Whole envelope repeats; the final target need not match initial. */
  loop?: boolean;
}
export interface MsegControls { trigger: Node<'bool'>; reset: Node<'bool'> }
export interface MsegOutput { value: Node<'f32'>; done: Node<'bool'>; segment: Node<'f32'> }
export interface SampleAndHoldConfig { initial: number }
export interface RandomModulatorConfig extends SampleAndHoldConfig { seed: number }
export interface RandomModulatorControls {
  /** Level-sensitive sample request: advances once on every high sample. */
  trigger: Node<'bool'>;
  reset: Node<'bool'>;
  /** rho in rho*previous+(1-rho)*uniform; clamped [0,1]. */
  correlation: Node<'f32'>;
}

function checkRate(rate: number) {
  if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) throw new RangeError('modulation sampleRate must be an integer in [8000,192000]');
}
function boundedNumber(value: number, lo: number, hi: number, name: string) {
  if (!Number.isFinite(value) || value < lo || value > hi) throw new RangeError(`${name} must be finite in [${lo},${hi}]`);
}
function checkClock(config: MusicalClockConfig) {
  checkRate(config.sampleRate);
  if (config.mode !== 'free' && config.mode !== 'tempo') throw new RangeError('clock mode must be free or tempo');
  if (!Number.isInteger(config.steps) || config.steps < 1 || config.steps > 64) throw new RangeError('clock steps must be an integer in [1,64]');
  const division = config.stepsPerBeat ?? 1;
  if (!Number.isFinite(division) || division < 1 / 64 || division > 64 || !Number.isInteger(Math.log2(division))) {
    throw new RangeError('stepsPerBeat must be a power of two in [1/64,64]');
  }
  if (config.mode === 'free' && division !== 1) throw new RangeError('stepsPerBeat applies only to tempo mode');
}

// Core 0.4.1 flushes tiny scalar-state writes. Exact power-of-two scaling
// preserves every finite f32 control, including subnormals, without a new
// amplitude threshold. Even the largest finite f32 input remains finite here.
const SCALE = 2 ** 128;
const PHASE_MAX = 1 - 2 ** -24;

const clockCore = defineSubgraph((config: MusicalClockConfig) => {
  checkClock(config);
  const threshold = config.sampleRate * (config.mode === 'tempo' ? 60 : 1);
  const division = config.mode === 'tempo' ? config.stepsPerBeat ?? 1 : 1;
  const lastPosition = config.steps - 2 ** (Math.ceil(Math.log2(config.steps)) - 53);
  const position = state.f64(0).named('positionScaled');
  const error = state.f64(0).named('errorScaled');
  const step = state.i32(0).named('step');
  const pending = state.bool(true).named('pending');
  const previousSeek = state.bool(false).named('previousSeek');
  // Explicit materialization keeps capture/compile work bounded for composed
  // consumers, rather than expanding shared arithmetic recursively.
  const current = state.f64(0).named('currentScaled');
  const increment = state.f64(0).named('incrementScaled');
  const sum = state.f64(0).named('sumScaled');
  const nextError = state.f64(0).named('nextErrorScaled');
  return {
    tick(c: MusicalClockControls) {
      const seek = c.seek.and(previousSeek.read().not()).and(c.reset.not());
      const request = f64(c.position.clamp(-1048576, 1048576));
      const wrapped = request.sub(request.div(config.steps).floor().mul(config.steps)).min(lastPosition);
      const targetStep = wrapped.floor();
      const oldStep = select(c.reset, i32(0), select(seek, i32(targetStep), step.read()));
      current.write(select(c.reset, f64(0), select(seek, wrapped.sub(targetStep).mul(threshold * SCALE), position.read())));
      const compensation = select(c.reset.or(seek), f64(0), error.read());
      // A positive compensation at an exactly rounded threshold means the
      // true position is still below the boundary. Preserve that distinction
      // for gate=1 and crossing decisions (no epsilon or early sample tick).
      const phase = current.read().sub(compensation).div(threshold * SCALE).clamp(0, 1 - 2 ** -53);
      const pulse = c.reset.not().and(seek.or(pending.read()));
      // Accumulate frequency units, not rounded samples-per-step or repeated
      // fractional periods. Compensated summation preserves fractional tempos.
      increment.write(f64(c.rate.clamp(0, 1000)).mul(division * SCALE).sub(compensation));
      sum.write(current.read().add(increment.read()));
      nextError.write(sum.read().sub(current.read()).sub(increment.read()));
      const crossed = sum.read().gt(threshold * SCALE).or(sum.read().eq(threshold * SCALE).and(nextError.read().lte(0)));
      const next = sum.read().sub(select(crossed, f64(threshold * SCALE), f64(0)));
      const nextStep = oldStep.add(select(crossed, i32(1), i32(0)));
      error.write(select(c.reset, f64(0), nextError.read()));
      position.write(select(c.reset, f64(0), next));
      step.write(select(c.reset, i32(0), select(nextStep.gte(config.steps), i32(0), nextStep)));
      pending.write(c.reset.or(crossed));
      previousSeek.write(c.seek);
      return { step: f32(oldStep), phase: f32(phase).clamp(0, PHASE_MAX), phase64: phase, tick: pulse };
    },
  };
});

/** Sample clock, no transport or event scheduler. Call exactly once per sample. */
export const musicalClock = defineSubgraph((config: MusicalClockConfig) => {
  const clock = instantiate(clockCore, config, { name: 'clock' });
  return { tick(c: MusicalClockControls): MusicalClockOutput {
    const value = clock.tick(c);
    return { step: value.step, phase: value.phase, tick: value.tick };
  } };
});

/** Fixed step values and gate fractions; no MIDI generation or smoothing. */
export const stepSequence = defineSubgraph((config: StepSequenceConfig) => {
  if (!Array.isArray(config.steps) || config.steps.length < 1 || config.steps.length > 64) throw new RangeError('sequence requires 1..64 steps');
  const steps = config.steps.map(step => {
    boundedNumber(step.value, -1, 1, 'step value');
    boundedNumber(step.gate, 0, 1, 'step gate');
    return { value: step.value, gate: step.gate };
  });
  const clock = instantiate(clockCore, { ...config, steps: steps.length }, { name: 'clock' });
  return { tick(c: MusicalClockControls): StepSequenceOutput {
    const t = clock.tick(c);
    let value = f32(steps[0].value), gate = f64(steps[0].gate);
    for (let n = 1; n < steps.length; n++) {
      value = select(t.step.eq(n), f32(steps[n].value), value);
      gate = select(t.step.eq(n), f64(steps[n].gate), gate);
    }
    return { value, step: t.step, phase: t.phase, tick: t.tick,
      gate: c.reset.not().and(t.phase64.lt(gate)) };
  } };
});

/**
 * Fixed piecewise envelope. Rising trigger emits the first duration step;
 * held trigger does not retrigger. Reset consumes trigger and emits initial.
 * Zero-length segments collapse at their boundary in list order. Loop jumps
 * from last target to the first segment's first step on the next sample.
 */
export const mseg = defineSubgraph((config: MsegConfig) => {
  checkRate(config.sampleRate);
  boundedNumber(config.initial, -1, 1, 'MSEG initial');
  if (!Array.isArray(config.segments) || config.segments.length < 1 || config.segments.length > 16) throw new RangeError('MSEG requires 1..16 segments');
  if (config.loop !== undefined && typeof config.loop !== 'boolean') throw new RangeError('MSEG loop must be boolean');
  let total = 0, startValue = config.initial;
  const segments = config.segments.map(segment => {
    boundedNumber(segment.seconds, 0, 30, 'MSEG seconds');
    boundedNumber(segment.target, -1, 1, 'MSEG target');
    if (!['linear', 'easeIn', 'easeOut', 'smoothstep'].includes(segment.curve)) throw new RangeError('unknown MSEG curve');
    const frames = Math.round(segment.seconds * config.sampleRate);
    const result = { ...segment, start: total, frames, startValue };
    total += frames; startValue = segment.target;
    return result;
  });
  if (config.loop && total === 0) throw new RangeError('looped MSEG needs at least one duration sample');
  const frame = state.i32(0).named('frame');
  const started = state.bool(false).named('started');
  const previousTrigger = state.bool(false).named('previousTrigger');
  return { tick(c: MsegControls): MsegOutput {
    const trigger = c.trigger.and(previousTrigger.read().not()).and(c.reset.not());
    const active = c.reset.not().and(started.read().or(trigger));
    const advance = config.loop ? select(frame.read().gte(total), i32(1), frame.read().add(1)) : frame.read().add(1).min(total);
    frame.write(select(active, select(trigger, i32(Math.min(1, total)), advance), i32(0)));
    const elapsed = frame.read();
    let value = f64(config.initial), index = i32(0);
    for (let n = 0; n < segments.length; n++) {
      const s = segments[n];
      const t = f64(elapsed.sub(s.start)).div(Math.max(1, s.frames)).clamp(0, 1);
      const curve = s.curve === 'easeIn' ? t.mul(t) : s.curve === 'easeOut' ? t.mul(f64(2).sub(t)) : s.curve === 'smoothstep' ? t.mul(t).mul(f64(3).sub(t.mul(2))) : t;
      const applicable = active.and(s.frames === 0 ? elapsed.gte(s.start) : elapsed.gt(s.start));
      const next = s.frames === 0 ? f64(s.target) : f64(s.startValue).add(curve.mul(s.target - s.startValue));
      value = select(applicable, next, value);
      index = select(applicable, i32(n), index);
    }
    started.write(active);
    previousTrigger.write(c.trigger);
    return { value: f32(value).clamp(-1, 1), segment: f32(index), done: active.not().or(bool(!config.loop).and(elapsed.gte(total))) };
  } };
});

/** Level-sensitive sampling; full finite f32 range. Native state maps -0 to +0. */
export const sampleAndHold = defineSubgraph((config: SampleAndHoldConfig) => {
  boundedNumber(config.initial, -1, 1, 'sampleAndHold initial');
  const held = state.f64(config.initial * SCALE).named('heldScaled');
  return { tick(input: Node<'f32'>, trigger: Node<'bool'>, reset: Node<'bool'>) {
    held.write(select(reset, f64(config.initial * SCALE), select(trigger, f64(input).mul(SCALE), held.read())));
    return f32(held.read().div(SCALE));
  } };
});

/**
 * Park-Miller seeded S&H / bounded correlated random. Each high trigger advances
 * the PRNG, including correlation=1. Reset wins, restores seed/initial, and
 * never advances. This is a convex random recurrence, not normalized Gaussian
 * noise or a specified spectral color. All dynamic inputs must be finite.
 */
export const randomModulator = defineSubgraph((config: RandomModulatorConfig) => {
  boundedNumber(config.initial, -1, 1, 'random initial');
  if (!Number.isInteger(config.seed) || config.seed < 1 || config.seed > 2147483646) throw new RangeError('random seed must be an integer in [1,2147483646]');
  const seed = state.f64(config.seed).named('seed');
  const value = state.f64(config.initial * SCALE).named('valueScaled');
  return { tick(c: RandomModulatorControls) {
    // Product <= 3.61e13 < 2^53; all integer arithmetic is exactly represented.
    const product = seed.read().mul(16807);
    const nextSeed = product.sub(product.div(2147483647).floor().mul(2147483647));
    seed.write(select(c.reset, f64(config.seed), select(c.trigger, nextSeed, seed.read())));
    const uniform = seed.read().sub(1).div(2147483645).mul(2).sub(1);
    const rho = f64(c.correlation.clamp(0, 1));
    const next = value.read().mul(rho).add(uniform.mul(f64(1).sub(rho)).mul(SCALE));
    value.write(select(c.reset, f64(config.initial * SCALE), select(c.trigger, next, value.read())));
    return f32(value.read().div(SCALE)).clamp(-1, 1);
  } };
});

export interface ArpeggiatorNote { note: number; velocity: number; gate: number }
export interface FixedArpeggiatorConfig extends Omit<MusicalClockConfig, 'steps'> {
  channel: number;
  /** Fixed order, 1..64 notes. gate=0 is a rest; no incoming chord capture. */
  notes: readonly ArpeggiatorNote[];
}
export interface FixedArpeggiatorControls extends MusicalClockControls {
  /** Native unsigned 32-bit absolute timestamp bits, carried by an i32 node. */
  atSample: Node<'i32'>;
}
export interface FixedArpeggiatorOutput extends MusicalClockOutput { note: Node<'f32'>; gate: Node<'bool'> }

/**
 * Bounded fixed-note arp using a caller-owned native MIDI output. At most one
 * off then one on per sample. Output capacity >=256 plus per-quantum draining
 * is required for the conservative burst bound, not guaranteed host delivery.
 * Rate zero holds a sounding note; reset before stopping/disconnecting.
 */
export const fixedArpeggiator = defineSubgraph((config: FixedArpeggiatorConfig) => {
  if (!Number.isInteger(config.channel) || config.channel < 0 || config.channel > 15) throw new RangeError('arp channel must be an integer in [0,15]');
  if (!Array.isArray(config.notes) || config.notes.length < 1 || config.notes.length > 64) throw new RangeError('arp requires 1..64 notes');
  const notes = config.notes.map(note => {
    if (!Number.isInteger(note.note) || note.note < 0 || note.note > 127) throw new RangeError('arp note must be an integer in [0,127]');
    if (!Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127) throw new RangeError('arp velocity must be an integer in [1,127]');
    boundedNumber(note.gate, 0, 1, 'arp gate');
    return { ...note };
  });
  const clock = instantiate(clockCore, { ...config, steps: notes.length }, { name: 'clock' });
  const active = state.bool(false).named('active');
  const activeNote = state.i32(notes[0].note).named('activeNote');
  return { tick(output: MidiOutputHandle, c: FixedArpeggiatorControls): FixedArpeggiatorOutput {
    const t = clock.tick(c);
    let note = i32(notes[0].note), velocity = i32(notes[0].velocity), fraction = f64(notes[0].gate);
    for (let n = 1; n < notes.length; n++) {
      note = select(t.step.eq(n), i32(notes[n].note), note);
      velocity = select(t.step.eq(n), i32(notes[n].velocity), velocity);
      fraction = select(t.step.eq(n), f64(notes[n].gate), fraction);
    }
    const gate = c.reset.not().and(t.phase64.lt(fraction));
    const previous = active.read();
    const off = previous.and(gate.not().or(t.tick));
    const on = gate.and(previous.not().or(t.tick));
    output.emitIf(off, { type: 'noteOff', channel: config.channel, note: activeNote.read(), velocity: 0, atSample: c.atSample });
    output.emitIf(on, { type: 'noteOn', channel: config.channel, note, velocity, atSample: c.atSample });
    activeNote.write(select(on, note, activeNote.read()));
    active.write(gate);
    return { note: f32(note), gate, step: t.step, phase: t.phase, tick: t.tick };
  } };
});
