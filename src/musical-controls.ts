import { defineSubgraph, f32, f64, i32, instantiate, select, state, type Node } from '@unworklet/core';
import { musicalClock } from './modulation.js';

export interface CurvedAdsrConfig { sampleRate: number }
export interface CurvedAdsrControls {
  gate: Node<'bool'>;
  /** Level-sensitive; ignored while gate is false. */
  retrigger: Node<'bool'>;
  /** Wins over all other controls and consumes the gate level. */
  reset: Node<'bool'>;
  /** Seconds, clamped [0,30], rounded to the nearest sample (half up). */
  attack: Node<'f32'>;
  decay: Node<'f32'>;
  sustain: Node<'f32'>;
  release: Node<'f32'>;
  /** Latched segment bends [-1,1]: -1 ease-in, 0 linear, +1 ease-out. */
  attackBend: Node<'f32'>;
  decayBend: Node<'f32'>;
  releaseBend: Node<'f32'>;
}
export interface CurvedAdsrOutput { level: Node<'f32'>; done: Node<'bool'> }

function checkSampleRate(sampleRate: number) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('musical controls sampleRate must be an integer in [8000,192000]');
  }
}

// Core 0.4.1 flushes tiny scalar-state writes. Scaling by this exact power of two
// preserves the entire finite f32 range in the bounded level/bend histories.
const SCALE = 2 ** 128;

/**
 * Segment-relative curved ADSR. Tick exactly once per sample; finite controls.
 * C(t,b)=t+b*t*(1-t), with exact endpoints. Segment settings latch on entry;
 * decay latches at the preceding positive attack endpoint. Sustain follows its
 * current input in the sustain stage. Retrigger/note-off start at the last
 * emitted f32 level. Zero attack collapses into decay on the same sample.
 * Reset > gate-off > retrigger. Reset consumes held gate. No smoothing/tail
 * threshold; zero sustain remains active. Bend zero is linear, not a promise of
 * byte identity with the legacy iterative envelope. See the entry contract.
 */
export const curvedAdsr = defineSubgraph((config: CurvedAdsrConfig) => {
  checkSampleRate(config.sampleRate);
  const stage = state.i32(0).named('stage'); // idle, attack, decay, sustain, release
  const previousGate = state.bool(false).named('previousGate');
  const total = state.i32(0).named('total');
  const elapsed = state.i32(0).named('elapsed');
  const start = state.f64(0).named('startScaled');
  const target = state.f64(0).named('targetScaled');
  const bend = state.f64(0).named('bendScaled');
  const level = state.f64(0).named('levelScaled');
  const frames = (seconds: Node<'f32'>) => i32(f64(seconds.clamp(0, 30)).mul(config.sampleRate).add(0.5).floor());

  return { tick(c: CurvedAdsrControls): CurvedAdsrOutput {
    const oldStage = stage.read();
    const on = c.gate.and(previousGate.read().not().or(c.retrigger));
    const off = c.gate.not().and(previousGate.read()).and(oldStage.eq(0).not());
    const a = frames(c.attack), d = frames(c.decay), r = frames(c.release);
    const sustain = f64(c.sustain.clamp(0, 1)).mul(SCALE);
    const attackBend = f64(c.attackBend.clamp(-1, 1)).mul(SCALE);
    const decayBend = f64(c.decayBend.clamp(-1, 1)).mul(SCALE);
    const releaseBend = f64(c.releaseBend.clamp(-1, 1)).mul(SCALE);

    stage.write(select(off, i32(4), select(on, i32(1), oldStage)));
    const active = stage.read(), attack = active.eq(1), release = active.eq(4);
    const zeroAttack = attack.and(select(on, a, total.read()).eq(0));
    const decay = active.eq(2).or(zeroAttack);
    const moving = attack.or(decay).or(release);
    total.write(select(release, select(off, r, total.read()),
      select(decay, select(zeroAttack, d, total.read()), select(on, a, total.read()))));
    elapsed.write(select(on.or(off).or(zeroAttack), i32(0), elapsed.read()));
    start.write(select(zeroAttack, f64(SCALE), select(on.or(off), level.read(), start.read())));
    target.write(select(release, f64(0), select(decay,
      select(zeroAttack, sustain, target.read()), f64(SCALE))));
    bend.write(select(release, select(off, releaseBend, bend.read()),
      select(decay, select(zeroAttack, decayBend, bend.read()), select(on, attackBend, bend.read()))));
    elapsed.write(select(moving, elapsed.read().add(1).min(total.read()), elapsed.read()));

    const t = f64(elapsed.read()).div(f64(total.read().max(1)));
    const curved = t.add(bend.read().div(SCALE).mul(t).mul(f64(1).sub(t)));
    const last = elapsed.read().gte(total.read()).or(release.and(start.read().eq(0)));
    const advanced = select(last, target.read(), start.read().add(target.read().sub(start.read()).mul(curved)));
    const emitted = f32(select(c.reset, f64(0), select(moving, advanced,
      select(active.eq(3), sustain, f64(0)))).div(SCALE)).clamp(0, 1);
    // Store the actual f32 output: interruption starts at the observable level,
    // not a hidden higher-precision value or a post-warped absolute amplitude.
    level.write(f64(emitted).mul(SCALE));
    const nextStage = select(c.reset, i32(0), select(moving.and(last),
      select(release, i32(0), select(decay, i32(3), i32(2))), select(decay, i32(2), active)));
    const prepareDecay = attack.and(decay.not()).and(last);
    total.write(select(c.reset, i32(0), select(prepareDecay, d, total.read())));
    elapsed.write(select(c.reset.or(prepareDecay), i32(0), elapsed.read()));
    start.write(select(c.reset, f64(0), select(prepareDecay, f64(SCALE), start.read())));
    target.write(select(c.reset, f64(0), select(prepareDecay, sustain, target.read())));
    bend.write(select(c.reset, f64(0), select(prepareDecay, decayBend, bend.read())));
    stage.write(nextStage);
    previousGate.write(c.gate);
    return { level: f32(level.read().div(SCALE)), done: nextStage.eq(0) };
  } };
});

export type MusicalLfoWaveform = 'sine' | 'triangle' | 'saw' | 'square';
export interface MusicalLfoConfig {
  sampleRate: number;
  mode: 'free' | 'tempo';
  waveform: MusicalLfoWaveform;
  /** Tempo mode only, power of two in [1/64,64], default 1. */
  beatsPerCycle?: number;
}
export interface MusicalLfoControls {
  /** Free: Hz [0,20]. Tempo: BPM [0,1000]. */
  rate: Node<'f32'>;
  /** Hold the base clock at zero; offset still applies. Consumes seek level. */
  reset: Node<'bool'>;
  /** Rising-edge seek, including while held. Reset wins. */
  seek: Node<'bool'>;
  /** Seek position in cycles, clamped +/-1048576 then wrapped. */
  position: Node<'f32'>;
  /** Live cycles offset, clamped +/-1048576. May deliberately jump. */
  phaseOffset: Node<'f32'>;
  /** Stops base-phase integration; seek/reset and live offset still apply. */
  hold: Node<'bool'>;
}
export interface MusicalLfoOutput {
  value: Node<'f32'>;
  /** Canonical f32 waveform phase [0,1), capped at 1-2^-24. */
  phase: Node<'f32'>;
}
const PHASE_MAX = 1 - 2 ** -24;

function sineAtPhase(phase: Node<'f64'>) {
  const centered = phase.sub(select(phase.gt(.5), f64(1), f64(0)));
  const folded = select(centered.gt(.25), f64(.5).sub(centered),
    select(centered.lt(-.25), f64(-.5).sub(centered), centered));
  const x = folded.mul(2 * Math.PI), x2 = x.mul(x);
  // Same degree-13 reflected sine as the legacy LFO. At this canonical public
  // f32 phase, |Taylor remainder| <= (pi/2)^15/15! < 7e-10 before output rounding.
  const polynomial = f64(1 / 6227020800).mul(x2).sub(1 / 39916800)
    .mul(x2).add(1 / 362880).mul(x2).sub(1 / 5040)
    .mul(x2).add(1 / 120).mul(x2).sub(1 / 6).mul(x2).add(1);
  return x.mul(polynomial);
}

/**
 * Fixed-waveform LFO composed from musicalClock. Tick once per sample with finite
 * inputs. Output precedes integration. Held reset pins base zero; release emits
 * zero base before resuming. Hold/rate zero preserve base phase. Tempo follows
 * BPM/(60*beatsPerCycle) exactly within the clock's numerical contract, including
 * up to 1066 2/3 Hz. Public f32 clock-phase quantization is intentional, not the
 * legacy sine LFO's internal-f64 phase guarantee. Waveforms are non-bandlimited;
 * phase/offset/reset changes can jump. No smoothing/depth/routing/transport.
 */
export const musicalLfo = defineSubgraph((config: MusicalLfoConfig) => {
  checkSampleRate(config.sampleRate);
  if (config.mode !== 'free' && config.mode !== 'tempo') throw new RangeError('musicalLfo mode must be free or tempo');
  if (!['sine', 'triangle', 'saw', 'square'].includes(config.waveform)) throw new RangeError('unsupported musicalLfo waveform');
  const beats = config.beatsPerCycle ?? 1;
  if (!Number.isFinite(beats) || beats < 1 / 64 || beats > 64 || !Number.isInteger(Math.log2(beats))) {
    throw new RangeError('beatsPerCycle must be a power of two in [1/64,64]');
  }
  if (config.mode === 'free' && beats !== 1) throw new RangeError('beatsPerCycle applies only to tempo mode');
  const clock = instantiate(musicalClock, {
    sampleRate: config.sampleRate, mode: config.mode, steps: 1, stepsPerBeat: config.mode === 'tempo' ? 1 / beats : 1,
  }, { name: 'clock' });
  return { tick(c: MusicalLfoControls): MusicalLfoOutput {
    const base = clock.tick({ rate: select(c.hold, f32(0), c.rate.clamp(0, config.mode === 'free' ? 20 : 1000)),
      reset: c.reset, seek: c.seek, position: c.position });
    const offset = f64(c.phaseOffset.clamp(-1048576, 1048576));
    // Remove the integer part toward zero, preserving negative tiny fractions.
    // Add only the signed fraction so large integral offsets cannot erase a
    // tiny base phase. Wrap once afterward and cap the rounded upper endpoint.
    const fraction = offset.sub(select(offset.lt(0), offset.neg().floor().neg(), offset.floor()));
    const shifted = f64(base.phase).add(fraction);
    const phase = f32(shifted.sub(shifted.floor())).clamp(0, PHASE_MAX);
    const p = f64(phase);
    const value = config.waveform === 'sine' ? sineAtPhase(p)
      : config.waveform === 'triangle' ? select(p.lt(.25), p.mul(4), select(p.lt(.75), f64(2).sub(p.mul(4)), p.mul(4).sub(4)))
      : config.waveform === 'saw' ? p.mul(2).sub(1)
      : select(p.lt(.5), f64(1), f64(-1));
    return { value: f32(value).clamp(-1, 1), phase };
  } };
});
