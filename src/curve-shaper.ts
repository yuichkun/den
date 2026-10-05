import { defineSubgraph, f32, f64, select, state, type Node } from '@unworklet/core';

export type CurveShaperQuality = 'direct' | 'adaa';
export interface CurveShaperConfig {
  sampleRate: number;
  /** Fixed count of equally spaced input knots on [-1,1], integer 2..17. */
  pointCount: number;
  /** Immutable quality. First-order interval averaging is not oversampling. */
  quality?: CurveShaperQuality;
}
export interface CurveShaperControls {
  /** Exactly pointCount audio-rate y values. Each clamps to [-1,1], NaN -> 0. */
  ordinates: readonly Node<'f32'>[];
  /** Linear multiplier [0,32]. Changes affect the current driven input. */
  gain: Node<'f32'>;
  /** Immediate blend [0,1]. ADAA dry uses a two-sample average. */
  mix: Node<'f32'>;
  /** Clear histories before processing this sample, including its curve edits. */
  reset: Node<'bool'>;
}
const HISTORY_SCALE = 2 ** 128;
function bounded(value: Node<'f32'>, low: number, high: number) {
  const wide = f64(value);
  return select(wide.eq(wide), wide, f64(0)).clamp(low, high);
}

/** Bounded editable piecewise-linear LUT, optionally first-order antialiased for
 * fixed curves. Curve edits use current ordinates over the whole input interval;
 * their modulation is not smoothed or guaranteed alias-free. Call once/sample.
 */
export const curveShaper = defineSubgraph((config: CurveShaperConfig) => {
  const { sampleRate, pointCount, quality = 'adaa' } = config;
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('curveShaper sampleRate must be in [8000,192000] Hz');
  if (!Number.isInteger(pointCount) || pointCount < 2 || pointCount > 17) throw new RangeError('curveShaper pointCount must be an integer in [2,17]');
  if (quality !== 'direct' && quality !== 'adaa') throw new RangeError('unknown curveShaper quality');
  const previous = quality === 'adaa' ? state.f64(0).named('previous-driven-scaled') : undefined;
  const previousDry = quality === 'adaa' ? state.f64(0).named('previous-dry-scaled') : undefined;
  const extent = pointCount - 1;
  return { tick(input: Node<'f32'>, controls: CurveShaperControls): Node<'f32'> {
    if (controls.ordinates.length !== pointCount) throw new RangeError('curveShaper ordinates must contain exactly pointCount nodes');
    const y = controls.ordinates.map(value => bounded(value, -1, 1));
    const dry = bounded(input, -8, 8), x = dry.mul(bounded(controls.gain, 0, 32));
    const mix = bounded(controls.mix, 0, 1);
    // Integer knot coordinates avoid asymmetry from rounded fractional knots.
    const coordinate = x.mul(extent);
    const segment = (value: Node<'f64'>, i: number) => {
      const left = -extent + 2 * i, right = left + 2;
      const difference = y[i + 1].sub(y[i]), slope = difference.mul(.5);
      const nonzero = slope.eq(0).not();
      // Anchor a sign-crossing segment at its zero, preserving tiny input for
      // e.g. the two-point identity LUT. All select branches execute: protect
      // zero slope even when its root is not selected.
      const root = select(y[i].eq(0), f64(left), select(y[i + 1].eq(0), f64(right),
        y[i + 1].mul(left).sub(y[i].mul(right)).div(select(nonzero, difference, f64(1)))));
      const crossing = y[i].mul(y[i + 1]).lte(0).and(nonzero);
      return select(crossing, value.sub(root).mul(slope), y[i].add(value.sub(left).mul(slope)));
    };
    const shape = (value: Node<'f64'>) => {
      let output = y[pointCount - 1];
      for (let i = pointCount - 2; i >= 0; i--) {
        output = select(value.lt(-extent + 2 * (i + 1)), segment(value, i), output);
      }
      return select(value.lte(-extent), y[0], output);
    };
    let wet: Node<'f64'>, alignedDry = dry;
    if (previous && previousDry) {
      const last = select(controls.reset, f64(0), previous.read().div(HISTORY_SCALE));
      const lastDry = select(controls.reset, f64(0), previousDry.read().div(HISTORY_SCALE));
      const lastCoordinate = last.mul(extent);
      const low = coordinate.min(lastCoordinate), high = coordinate.max(lastCoordinate), distance = high.sub(low);
      // In integer-knot coordinates |dy/dt| <= 1. Mean-vs-midpoint
      // error <= distance/4 <=2.5e-7, including knot crossings.
      const close = distance.lte(1e-6);
      let area = high.min(-extent).sub(low).max(0).mul(y[0])
        .add(high.sub(low.max(extent)).max(0).mul(y[pointCount - 1]));
      for (let i = 0; i < pointCount - 1; i++) {
        const left = -extent + 2 * i, right = left + 2;
        const a = low.clamp(left, right), b = high.clamp(left, right);
        area = area.add(b.sub(a).mul(segment(a.add(b).mul(.5), i)));
      }
      wet = select(close, shape(coordinate.add(lastCoordinate).mul(.5)), area.div(select(close, f64(1), distance)));
      alignedDry = dry.add(lastDry).mul(.5);
      previous.write(x.mul(HISTORY_SCALE));
      previousDry.write(dry.mul(HISTORY_SCALE));
    } else wet = shape(coordinate);
    return f32(alignedDry.mul(f64(1).sub(mix)).add(wet.mul(mix)));
  } };
});
