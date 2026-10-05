import { defineSubgraph, f32, f64, i32, select, state, type EveryNSamples, type Node } from '@unworklet/core';
import { spectralForEach } from './spectral-fft.js';
import type { ResidentSample } from './sample.js';

export interface ResidentTimeStretchConfig {
  /** Match ctx.sampleRate; integer 8000..192000. */
  sampleRate: number;
  /** Resident sourceSampleRate must also be an integer in [8000,192000]. */
  sample: ResidentSample;
  /** Fixed synthesis hop. Window length is twice this value; default 256. */
  hopSamples?: 128 | 256;
  /** Integer source-frame offsets searched, independently of source rate.
   * Zero disables alignment. Default 64; compare 64 points per candidate. */
  searchFrames?: 0 | 8 | 16 | 32 | 64 | 128;
}
export interface ResidentTimeStretchControls {
  gate: Node<'bool'>;
  /** Level-sensitive request. Starts at the next global hop boundary while
   * gate stays high. Held trigger restarts each hop; it can click. */
  trigger: Node<'bool'>;
  /** Silences/cancels now. Does not rephase the global hop clock. */
  reset: Node<'bool'>;
  /** Output duration / original duration, [0.5,2], latched at actual launch.
   * Invalid values reject that launch. Changes need a fresh trigger. */
  durationScale: Node<'f32'>;
  /** Grain-local pitch multiplier, [0.5,2], latched at actual launch. */
  pitchRatio: Node<'f32'>;
}
// Exact binary internal scaling protects tiny waveform differences from the
// native 1e-30 scalar-store scrub. Even opposite finite f32 extrema produce
// a 64-term squared score below 2**649, far inside finite f64 range.
const SCALE = 2 ** 192;

/** Fixed-capacity mono resident WSOLA variant. Native 64-point squared-error
 * alignment and complementary linear overlap; no normalization or clipping.
 * True independent duration/pitch controls, with bounded search/transient and
 * interpolation/alias limitations. Call once in stride-1 forSample, passing
 * that loop's everyNSamples. Native snapshots continue only the same schema.
 */
export const residentTimeStretch = defineSubgraph((config: ResidentTimeStretchConfig) => {
  const { sample, sampleRate, hopSamples: H = 256, searchFrames: S = 64 } = config;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      !Number.isInteger(sample.sourceSampleRate) || sample.sourceSampleRate < 8000 || sample.sourceSampleRate > 192000 ||
      ![128, 256].includes(H) || ![0, 8, 16, 32, 64, 128].includes(S)) {
    throw new RangeError('residentTimeStretch requires integer sampleRate/sourceSampleRate [8000,192000], hopSamples 128/256 and searchFrames 0/8/16/32/64/128');
  }
  const active = state.bool(false).named('active'), pending = state.bool(false).named('pending');
  const ended = state.bool(false).named('ended'), rejected = state.bool(false).named('rejected');
  const previousGate = state.bool(false).named('previousGate'), revision = state.i32(-1).named('revision');
  const clock = state.i32(0).named('clock'), age = state.i32(0).named('age'), total = state.i32(0).named('total');
  const sourceLength = state.i32(0).named('sourceLength'), pitchStep = state.f64(1).named('pitchStep');
  const current = state.f64(0).named('currentStart'), previous = state.f64(0).named('previousStart');
  const first = state.bool(true).named('first'), offset = state.i32(0).named('selectedOffset');
  const reference = state.buffer.f64({ size: 64 }).expose({ name: 'referenceScaled', snapshot: 'transient' });
  const score = state.f64(0).expose({ name: 'scoreScaled', snapshot: 'transient' });
  const bestScore = state.f64(0).expose({ name: 'bestScoreScaled', snapshot: 'transient' });
  const bestOffset = state.i32(0).expose({ name: 'bestOffset', snapshot: 'transient' });
  const launching = state.bool(false).expose({ name: 'launching', snapshot: 'transient' });
  const oldValue = state.f64(0).expose({ name: 'oldValueScaled', snapshot: 'transient' });
  const wet = state.f64(0).expose({ name: 'wetScaled', snapshot: 'transient' });
  // Each PCM endpoint outside [0,length) is zero, including fractional reads
  // straddling either boundary. Clamp indices BEFORE calling the shared reader.
  const readScaled = (position: Node<'f64'>) => {
    const whole = position.floor(), fraction = position.sub(whole), end = sample.length();
    const a = f64(sample.read(whole.clamp(0, f64(end.sub(1).max(0))), i32(0), end, false));
    oldValue.write(select(whole.gte(0).and(whole.lt(f64(end))), a, f64(0)).mul(SCALE));
    const next = whole.add(1);
    const b = f64(sample.read(next.clamp(0, f64(end.sub(1).max(0))), i32(0), end, false));
    return oldValue.read().mul(f64(1).sub(fraction)).add(select(next.gte(0).and(next.lt(f64(end))), b, f64(0)).mul(SCALE).mul(fraction));
  };
  // Exact rational ceil(L * R * D / Rs) for integer rates and finite f32 D.
  // A=L*R<2**34 and K=D*2**24<=2**25. Split the >53-bit A*K product:
  // hi*K<2**43 and lo*K<2**41 are exact integers. Numerator / 2**16 is
  // represented by its integer part and a 16-bit remainder. The nearest
  // approximate integer q is either floor(exact) or ceil(exact), since the
  // absolute arithmetic error is far below 0.5. Exact comparison with
  // q*Rs*256 then returns the true ceil without an epsilon adjustment.
  const durationFrames = (duration: Node<'f32'>) => {
    const a = f64(sample.length()).mul(sampleRate), k = f64(duration).mul(2 ** 24);
    const hi = a.div(65536).floor(), loProduct = a.sub(hi.mul(65536)).mul(k);
    const integerPart = hi.mul(k).add(loProduct.div(65536).floor()), remainder = loProduct.mod(65536);
    const q = a.mul(f64(duration)).div(sample.sourceSampleRate).add(.5).floor();
    const target = q.mul(sample.sourceSampleRate).mul(256);
    const greater = integerPart.gt(target).or(integerPart.eq(target).and(remainder.gt(0)));
    return i32(q.add(select(greater, f64(1), f64(0))));
  };
  return {
    tick(c: ResidentTimeStretchControls, everyNSamples: EveryNSamples) {
      const missing = sample.length().eq(0), changed = sample.revision().eq(revision.read()).not();
      const clear = c.reset.or(changed).or(missing);
      active.write(active.read().and(clear.not()).and(c.gate));
      pending.write(pending.read().and(clear.not()).and(c.gate));
      ended.write(ended.read().and(clear.not()));
      rejected.write(rejected.read().and(c.reset.not()));
      age.write(select(clear, i32(0), age.read())); total.write(select(clear, i32(0), total.read()));
      sourceLength.write(select(clear, i32(0), sourceLength.read()));
      const request = c.trigger.or(c.gate.and(previousGate.read().not())).and(c.gate).and(c.reset.not()).and(missing.not());
      pending.write(pending.read().or(request));
      // 0.4.1 does not snapshot native everyNSamples counters. A 128-sample
      // scheduler realigns at every allowed snapshot boundary; persistent clock
      // carries H=256 phase. Search is eager every 128, even when not committing.
      everyNSamples(128, () => {
        const due = clock.read().eq(0), attempt = due.and(pending.read()).and(c.gate).and(c.reset.not());
        const valid = c.durationScale.gte(.5).and(c.durationScale.lte(2)).and(c.pitchRatio.gte(.5)).and(c.pitchRatio.lte(2));
        launching.write(attempt.and(valid).and(missing.not()));
        const launch = launching.read();
        pending.write(pending.read().and(attempt.not()));
        rejected.write(select(attempt, valid.not(), rejected.read()));
        age.write(select(launch, i32(0), age.read()));
        total.write(select(launch, durationFrames(select(valid, c.durationScale, f32(1))), total.read()));
        sourceLength.write(select(launch, sample.length(), sourceLength.read()));
        pitchStep.write(select(launch, f64(c.pitchRatio).mul(sample.sourceSampleRate / sampleRate), pitchStep.read()));
        active.write(active.read().or(launch)); ended.write(ended.read().and(launch.not()));
        const nominal = f64(age.read()).mul(f64(sourceLength.read())).div(f64(total.read().max(1)));
        const priorTail = current.read().add(pitchStep.read().mul(H));
        spectralForEach(64, j => reference.write(j, readScaled(priorTail.add(f64(j).mul(H / 64).mul(pitchStep.read())))));
        const compare = (candidate: Node<'i32'>) => {
          score.write(0);
          spectralForEach(64, j => {
            const value = readScaled(nominal.add(f64(candidate)).add(f64(j).mul(H / 64).mul(pitchStep.read())));
            const difference = value.sub(reference.read(j));
            score.write(score.read().add(difference.mul(difference)));
          });
        };
        compare(i32(0)); bestScore.write(score.read()); bestOffset.write(0);
        if (S > 0) spectralForEach(S * 2, j => {
          const distance = j.div(2).add(1), candidate = select(j.mod(2).eq(0), distance, distance.mul(-1));
          compare(candidate);
          const improve = score.read().lt(bestScore.read());
          bestOffset.write(select(improve, candidate, bestOffset.read()));
          bestScore.write(select(improve, score.read(), bestScore.read()));
        });
        const commit = due.and(active.read());
        previous.write(select(commit, select(launch, f64(0), priorTail), previous.read()));
        current.write(select(commit, select(launch, f64(0), nominal.add(f64(bestOffset.read()))), current.read()));
        offset.write(select(commit, select(launch, i32(0), bestOffset.read()), offset.read()));
        first.write(select(commit, launch, first.read()));
      });
      const exhausted = active.read().and(age.read().gte(total.read()));
      ended.write(ended.read().or(exhausted)); active.write(active.read().and(exhausted.not()));
      const playing = active.read();
      const local = f64(clock.read()).mul(pitchStep.read()), blend = f64(clock.read()).div(H);
      // Capture the first read because resident.read uses a shared transient.
      wet.write(readScaled(previous.read().add(local)));
      const incoming = readScaled(current.read().add(local));
      const mixed = select(first.read(), incoming, wet.read().mul(f64(1).sub(blend)).add(incoming.mul(blend)));
      const output = select(playing, f32(mixed.div(SCALE)), f32(0));
      const position = f32(f64(age.read().min(total.read())).mul(f64(sourceLength.read())).div(f64(total.read().max(1))));
      age.write(select(playing, age.read().add(1), age.read()));
      clock.write(clock.read().add(1).mod(H));
      previousGate.write(c.gate.and(c.reset.not())); revision.write(sample.revision());
      return { output, active: playing, position, ended: ended.read(), pending: pending.read(), rejected: rejected.read(), missing, selectedOffset: offset.read() };
    },
  };
});
