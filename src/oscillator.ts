import { defineSubgraph, f32, f64, select, state, type Node } from '@unworklet/core';

export interface OscillatorConfig { sampleRate: number; waveform: 'sine' | 'saw' }

/** Phase accumulator with sine or four-sample polynomial BLEP saw. */
export const oscillator = defineSubgraph((config: OscillatorConfig) => {
  if (!Number.isFinite(config.sampleRate) || config.sampleRate < 8000 || config.sampleRate > 192000) {
    throw new RangeError('oscillator sampleRate must be finite and in [8000, 192000] Hz');
  }
  if (config.waveform !== 'sine' && config.waveform !== 'saw') throw new RangeError('unknown oscillator waveform');
  const phase = state.f64(0).named('phase');
  return {
    /** Emit current phase, then advance. Reset emits phase zero on that sample. */
    tick(frequency: Node<'f32'>, reset: Node<'bool'>) {
      const dt = f64(frequency).clamp(0, 0.45 * config.sampleRate).div(config.sampleRate);
      const p = select(reset, f64(0), phase.read());
      phase.write(p.add(dt).frac());
      if (config.waveform === 'sine') {
        // Fold to [-pi/2, pi/2]; degree 13 has <7e-10 remainder here.
        const cycles = select(p.lt(0.25), p, select(p.lt(0.75), f64(0.5).sub(p), p.sub(1)));
        const angle = cycles.mul(2 * Math.PI), z = angle.mul(angle);
        const polynomial = f64(1 / 6227020800).mul(z).sub(1 / 39916800).mul(z).add(1 / 362880).mul(z).sub(1 / 5040).mul(z).add(1 / 120).mul(z).sub(1 / 6).mul(z).add(1);
        return f32(angle.mul(polynomial));
      }
      // A zero frequency holds phase; avoid 0/0 even in eagerly evaluated selects.
      const width = select(dt.gt(0), dt, f64(1));
      // Integrate a cubic B-spline kernel (four boxes convolved). Its step
      // complement for x >= 0 has support two sample intervals.
      const complement = (x: Node<'f64'>) => {
        const x2 = x.mul(x), outer = f64(2).sub(x).max(0);
        return select(x.lt(1), f64(0.5).sub(x.mul(2 / 3)).add(x2.mul(x).div(3)).sub(x2.mul(x2).div(8)), outer.mul(outer).mul(outer).mul(outer).div(24));
      };
      const correction = complement(p.div(width)).sub(complement(f64(1).sub(p).div(width))).mul(2);
      return f32(p.mul(2).sub(1).add(select(dt.gt(0), correction, f64(0))));
    },
  };
});
