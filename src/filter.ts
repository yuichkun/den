import { defineSubgraph, f32, f64, select, state, type Node } from '@unworklet/core';

export interface FilterConfig { sampleRate: number }

/** Trapezoidal state-variable low-pass. See docs/filter-oscillator.md. */
export const filter = defineSubgraph((config: FilterConfig) => {
  if (!Number.isFinite(config.sampleRate) || config.sampleRate < 8000 || config.sampleRate > 192000) {
    throw new RangeError('filter sampleRate must be finite and in [8000, 192000] Hz');
  }
  const maximum = Math.min(20000, 0.45 * config.sampleRate);
  const band = state.f64(0).named('band');
  const low = state.f64(0).named('low');
  return {
    /** Call exactly once per sample. Reset clears history before processing this input. */
    tick(input: Node<'f32'>, cutoff: Node<'f32'>, resonance: Node<'f32'>, reset: Node<'bool'>) {
      // Bounded-angle Taylor coefficients avoid the f32 transcendental lowering in 0.4.1.
      const angle = f64(cutoff).clamp(20, maximum).mul(Math.PI / config.sampleRate);
      const z = angle.mul(angle);
      const sine = angle.mul(f64(-1 / 6227020800).mul(z).add(1 / 39916800).mul(z).sub(1 / 362880).mul(z).add(1 / 5040).mul(z).sub(1 / 120).mul(z).add(1 / 6).mul(z).neg().add(1));
      const cosine = f64(-1 / 87178291200).mul(z).add(1 / 479001600).mul(z).sub(1 / 3628800).mul(z).add(1 / 40320).mul(z).sub(1 / 720).mul(z).add(1 / 24).mul(z).sub(1 / 2).mul(z).add(1);
      const g = sine.div(cosine);
      const k = f64(1).div(f64(resonance).clamp(0.5, 10));
      const s1 = select(reset, f64(0), band.read());
      const s2 = select(reset, f64(0), low.read());
      const v1 = s1.add(g.mul(f64(input).sub(s2))).div(g.mul(g.add(k)).add(1));
      const v2 = s2.add(g.mul(v1));
      band.write(v1.mul(2).sub(s1));
      low.write(v2.mul(2).sub(s2));
      return f32(v2);
    },
  };
});
