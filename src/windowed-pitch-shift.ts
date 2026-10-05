import { defineSubgraph, f32, f64, i32, select, state, type Node } from '@unworklet/core';

export interface WindowedPitchShiftConfig {
  /** Match the enclosing processor's ctx.sampleRate; integer 8000..192000. */
  sampleRate: number;
  /** Fixed delay sweep width, even integer 32..16384; default 2048.
   * A head's cycle lasts windowSamples / abs(1-ratio) output samples.
   * This is not a fixed-duration grain or an STFT frame. */
  windowSamples?: number;
}
export interface WindowedPitchShiftControls {
  /** Input-time speed [0.5,2]. Invalid values retain the last valid ratio,
   * or 1 on reset. Finite endpoints are accepted without epsilon. */
  ratio: Node<'f32'>;
  /** Level retrigger: use phase zero now, preserving history. Can click.
   * Held retrigger pins the current read to the initial midpoint delay. */
  retrigger: Node<'bool'>;
  /** Priority over retrigger. Silence/discard this sample, invalidate history,
   * and hold phase zero. A valid ratio is still accepted during reset. */
  reset: Node<'bool'>;
}
const SCALE = 2 ** 128;

/** Bounded mono two-window moving-readhead pitch effect. Call once per sample.
 * Finite f32 input required. Complementary triangular weights and linear reads
 * are convex: no implicit gain, feedback, dry/wet mix or bypass. Initially,
 * ratio 1 is a (1+windowSamples/2)-sample delay; unity after modulation may comb.
 * Read ages are [1,windowSamples+1]; no single latency for shifting audio.
 * Linear interpolation aliases, and windows can color/cancel/modulate audio.
 * No formant preservation, general time stretching or realtime guarantee.
 */
export const windowedPitchShift = defineSubgraph((config: WindowedPitchShiftConfig) => {
  const { sampleRate, windowSamples = 2048 } = config;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      !Number.isInteger(windowSamples) || windowSamples < 32 || windowSamples > 16384 || windowSamples % 2 !== 0) {
    throw new RangeError('windowedPitchShift requires integer sampleRate [8000,192000] and even windowSamples [32,16384]');
  }
  const size = windowSamples + 3;
  // Exact binary scaling avoids native tiny-state scrubbing, retaining all
  // finite f32 inputs without threatening f64 overflow at either endpoint.
  const history = state.buffer.f64({ size }).expose({ name: 'historyScaled', snapshot: 'persistent' });
  const cursor = state.i32(0).named('cursor'), valid = state.i32(0).named('valid');
  const phase = state.f64(0).named('phaseScaled'), ratio = state.f64(1).named('ratio');
  const wet = state.f64(0).expose({ name: 'wetScaled', snapshot: 'transient' });
  return {
    tick(input: Node<'f32'>, c: WindowedPitchShiftControls) {
      const accepted = c.ratio.gte(0.5).and(c.ratio.lte(2));
      ratio.write(select(accepted, f64(c.ratio), select(c.reset, f64(1), ratio.read())));
      phase.write(select(c.reset.or(c.retrigger), f64(0), phase.read()));
      const p = phase.read().div(SCALE), other = select(p.gte(0.5), p.sub(0.5), p.add(0.5));
      const weight = f64(1).sub(p.mul(2).sub(1).abs());
      const write = select(c.reset, i32(0), cursor.read()), available = select(c.reset, i32(0), valid.read());
      const at = (position: Node<'f64'>) => {
        const delay = position.mul(windowSamples).add(1), whole = i32(delay.floor()), fraction = delay.sub(f64(whole));
        const relative = write.sub(whole), recentIndex = select(relative.lt(0), relative.add(size), relative);
        const olderIndex = select(recentIndex.eq(0), i32(size - 1), recentIndex.sub(1));
        const recent = select(available.gte(whole), history.read(recentIndex), f64(0));
        const older = select(available.gt(whole), history.read(olderIndex), f64(0));
        return recent.mul(f64(1).sub(fraction)).add(older.mul(fraction));
      };
      // Materialize before advancing phase or overwriting the ring. Using the
      // exact complement guarantees unit DC gain at every crossfade position.
      wet.write(at(p).mul(weight).add(at(other).mul(f64(1).sub(weight))));
      history.write(write, f64(select(c.reset, f32(0), input)).mul(SCALE));
      cursor.write(select(c.reset, i32(0), write.add(1).mod(size)));
      valid.write(select(c.reset, i32(0), available.add(1).min(size)));
      const next = p.add(f64(1).sub(ratio.read()).div(windowSamples));
      phase.write(select(c.reset, f64(0), next.sub(next.floor()).mul(SCALE)));
      return { output: f32(wet.read().div(SCALE)), ratioRejected: accepted.not() };
    },
  };
});
