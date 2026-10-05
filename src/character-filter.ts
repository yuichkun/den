import { defineSubgraph, f32, f64, select, sqrt, state, type Node } from '@unworklet/core';

export interface CharacterFilterConfig { sampleRate: number }

const HISTORY_SCALE = 2 ** 128;
function bounded(value: Node<'f32'>, lower: number, upper: number, fallback: number) {
  const wide = f64(value);
  return select(wide.eq(wide), wide, f64(fallback)).clamp(lower, upper);
}

// 1 - exp(-x), 0 < x <= 2*pi/5. The degree-18 alternating polynomial
// avoids unworklet 0.4.1's f32 transcendental lowering. No unbounded domain.
function coefficient(x: Node<'f64'>) {
  let factorial = 1;
  const terms = [0];
  for (let n = 1; n <= 18; n++) { factorial *= n; terms.push((n % 2 ? 1 : -1) / factorial); }
  let value = f64(terms[18]);
  for (let n = 17; n >= 1; n--) value = value.mul(x).add(terms[n]);
  return value.mul(x);
}

/** Four saturating one-poles, current-sample cascade, one-sample global feedback.
 * poleHz is individual matched-z tuning, not overall -3 dB cutoff or Q.
 * See docs/character-filter.md for the exact topology and convex-state bound.
 */
export const characterFilter = defineSubgraph((config: CharacterFilterConfig) => {
  const { sampleRate } = config;
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('characterFilter sampleRate must be finite and in [8000, 192000] Hz');
  }
  const maximumHz = Math.min(20000, sampleRate / 5);
  const stages = Array.from({ length: 4 }, (_, i) => state.f64(0).named(`stage-${i + 1}-scaled`));
  return {
    /** Once per sample. Input [-8,8], poleHz [20,min(20000,fs/5)],
     * resonance [0,1] -> feedback [0,4], linear drive [0,16]. */
    tick(input: Node<'f32'>, poleHz: Node<'f32'>, resonance: Node<'f32'>, drive: Node<'f32'>, reset: Node<'bool'>) {
      const old = stages.map(slot => select(reset, f64(0), slot.read().div(HISTORY_SCALE)));
      // Materialize the coefficient in a captured history slot. All old states
      // are already locals; the normal stage-one history is restored below.
      stages[0].write(coefficient(bounded(poleHz, 20, maximumHz, 20).mul(2 * Math.PI / sampleRate)));
      const a = stages[0].read(), b = f64(1).sub(a);
      let value = bounded(input, -8, 8, 0).mul(bounded(drive, 0, 16, 1))
        .sub(old[3].mul(bounded(resonance, 0, 1, 0)).mul(4));
      for (let i = 0; i < 4; i++) {
        const saturated = value.div(sqrt(value.mul(value).add(1)));
        stages[i].write(old[i].mul(b).add(saturated.mul(a)).mul(HISTORY_SCALE));
        // read() is a materialized local. Avoid recursively duplicating the
        // nonlinear stage expression and preserve tiny audio between stages.
        value = stages[i].read().div(HISTORY_SCALE);
      }
      return f32(value);
    },
  };
});
