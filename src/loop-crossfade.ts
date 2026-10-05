import { bool, defineSubgraph, f32, f64, i32, select, state, type Node } from '@unworklet/core';
import type { ResidentSample, SamplePlayerControls } from './sample.js';

export interface CrossfadedLoopConfig {
  sampleRate: number;
  sample: ResidentSample;
  /** Fixed source slice [startFrame,endFrame), intersected with loaded length. */
  startFrame?: number;
  endFrame?: number;
  /** Source-frame overlap, 0..floor(slice length/2). Effective period is L-F,
   * and forward playback starts at startFrame+F. Zero disables the overlap. */
  crossfadeFrames: number;
  /** Linear gate-off ramp in output samples; zero/one stops on first off sample. */
  releaseFrames?: number;
}
const PHASE_SCALE = 2 ** 128;
function integer(value: number, low: number, high: number, name: string) {
  if (!Number.isInteger(value) || value < low || value > high) throw new RangeError(`${name} must be an integer in [${low},${high}]`);
}
// Preserve the local fraction before adding an integer slice/head offset. An
// absolute position addition would erase tiny phase * full-finite-PCM products.
// Resident reads retain the existing ingress, bounds and per-tap sanitization.
function localRead(sample: ResidentSample, local: Node<'f64'>, start: Node<'i32'>, end: Node<'i32'>, loop: Node<'bool'>) {
  const whole = i32(local.floor()), fraction = local.sub(f64(whole));
  const first = start.add(whole).min(end.sub(1).max(start));
  const next = select(first.add(1).gte(end), select(loop, start, first), first.add(1));
  const a = sample.read(f64(first), start, end, false), b = sample.read(f64(next), start, end, false);
  return f32(f64(a).mul(f64(1).sub(fraction)).add(f64(b).mul(fraction)));
}

/** One mono cyclic waveform with a unity-sum linear tail/head overlap. Shortens
 * the source period from L to L-F; reverse traverses that same waveform backward.
 * Not a dry-attack, time-stretching, antialiasing or arbitrary-content seam promise. */
export const crossfadedLoopPlayer = defineSubgraph((config: CrossfadedLoopConfig) => {
  if (!Number.isFinite(config.sampleRate) || config.sampleRate < 8000 || config.sampleRate > 192000) throw new RangeError('sampleRate must be in [8000,192000] Hz');
  const { sample, startFrame = 0, endFrame = sample.capacity, crossfadeFrames, releaseFrames = 0 } = config;
  integer(startFrame, 0, sample.capacity - 1, 'startFrame'); integer(endFrame, startFrame + 1, sample.capacity, 'endFrame');
  integer(crossfadeFrames, 0, Math.floor((endFrame - startFrame) / 2), 'crossfadeFrames');
  integer(releaseFrames, 0, Math.ceil(config.sampleRate * 10), 'releaseFrames');
  const phase = state.f64(0).named('scaledPhase'), active = state.bool(false).named('active');
  const previousGate = state.bool(false).named('previousGate'), revision = state.i32(-1).named('revision');
  const remaining = state.i32(0).named('releaseRemaining');
  // Transient materialization keeps repeated resident read graphs bounded. Only
  // persistent phase/gate/release/revision state is required across snapshots.
  const current = state.f64(0).expose({ name: 'scaledCurrentPhase', snapshot: 'transient' });
  const speedState = state.f64(0).expose({ name: 'scaledSpeed', snapshot: 'transient' });
  const endState = state.i32(0).expose({ name: 'end', snapshot: 'transient' });
  const overlapState = state.i32(0).expose({ name: 'overlap', snapshot: 'transient' });
  const periodState = state.i32(0).expose({ name: 'period', snapshot: 'transient' });
  return { tick(c: SamplePlayerControls) {
    endState.write(sample.length().min(endFrame));
    const end = endState.read(), start = i32(startFrame), length = end.sub(start).max(0), available = length.gt(0);
    overlapState.write(length.div(2).min(crossfadeFrames));
    periodState.write(length.sub(overlapState.read()));
    const overlap = overlapState.read(), period = periodState.read();
    speedState.write(select(c.rate.eq(c.rate), f64(c.rate), f64(0)).clamp(-16, 16).mul(sample.sourceSampleRate / config.sampleRate).mul(PHASE_SCALE));
    const speed = speedState.read().div(PHASE_SCALE), changed = sample.revision().eq(revision.read()).not();
    // A load is NOT a gate rise: evaluate against the actual prior gate first.
    const trigger = c.trigger.or(c.gate.and(previousGate.read().not())).and(c.gate).and(c.reset.not()).and(available);
    const alive = select(trigger, bool(true), active.read().and(changed.not())).and(c.reset.not()).and(available);
    const initial = select(speed.lt(0), f64(period.sub(1).max(0)), f64(0));
    current.write(select(trigger, initial, select(c.reset.or(changed).or(available.not()), f64(0), phase.read().div(PHASE_SCALE))).mul(PHASE_SCALE));
    const q = current.read().div(PHASE_SCALE);
    const releaseLeft = select(trigger, i32(releaseFrames), select(c.gate, remaining.read(), remaining.read().sub(1).max(0)));
    const gain = releaseFrames > 0 ? f64(releaseLeft).div(releaseFrames) : select(c.gate, f64(1), f64(0));
    active.write(alive.and(gain.gt(0)));
    const playing = active.read(), primaryStart = start.add(overlap);
    const tail = localRead(sample, q, primaryStart, end, overlap.eq(0));
    const headPhase = q.sub(f64(period.sub(overlap))).max(0);
    const head = localRead(sample, headPhase, start, end, bool(false));
    const weight = select(overlap.gt(0), headPhase.div(f64(overlap.max(1))), f64(0));
    const mixed = f32(f64(tail).mul(f64(1).sub(weight)).add(f64(head).mul(weight)));
    const output = select(playing, f32(f64(mixed).mul(gain)), f32(0));
    const advanced = q.add(speed), divisor = f64(period.max(1));
    const wrapped = advanced.sub(advanced.div(divisor).floor().mul(divisor));
    // Negative tiny increments can round a remainder to the upper endpoint.
    const next = select(wrapped.gte(divisor), f64(0), wrapped.max(0));
    phase.write(select(playing, next, q).mul(PHASE_SCALE));
    remaining.write(select(playing, releaseLeft, i32(0)));
    previousGate.write(c.gate.and(c.reset.not())); revision.write(sample.revision());
    return { output, active: playing, position: f32(f64(primaryStart).add(q)), phase: f32(q), periodFrames: period, crossfadeFrames: overlap, missing: available.not() };
  } };
});
