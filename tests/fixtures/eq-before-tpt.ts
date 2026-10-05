import { defineSubgraph, f32, f64, select, state, type Node } from '@unworklet/core';
import { boundedDbAmplitude, checkedSampleRate, tangentHalfAngle } from '../../src/catalog-filter-math.js';

export type BiquadEqMode = 'peaking' | 'lowShelf' | 'highShelf';
export interface BiquadEqConfig { sampleRate: number; mode: BiquadEqMode }

/** RBJ/BLT peaking or shelving EQ; shelves use monotonic slope S=1. */
export const biquadEq = defineSubgraph((config: BiquadEqConfig) => {
  const maximum = checkedSampleRate(config.sampleRate);
  if (!['peaking','lowShelf','highShelf'].includes(config.mode)) throw new TypeError('Unknown biquad EQ mode');
  const historyScale = 2 ** 128; // Preserve representable f32 histories across upstream state writes.
  const z1 = state.f64(0).named('z1'), z2 = state.f64(0).named('z2');
  const tangent = state.f64(0).named('coefficientG'), amplitude = state.f64(1).named('coefficientA');
  const normalization = state.f64(1).named('coefficientNormalization');
  return {
    /** Cutoff [20,min(20000,.45*fs)], Q [.5,10], gain [-24,24] dB. Q is unused by S=1 shelves. */
    tick(input: Node<'f32'>, cutoffHz: Node<'f32'>, q: Node<'f32'>, gainDb: Node<'f32'>, reset: Node<'bool'>) {
      const old1 = select(reset, f64(0), z1.read().div(historyScale)), old2 = select(reset, f64(0), z2.read().div(historyScale));
      tangent.write(tangentHalfAngle(cutoffHz, config.sampleRate, maximum));
      amplitude.write(boundedDbAmplitude(gainDb));
      const g = tangent.read(), A = amplitude.read(), gg = g.mul(g), divisor = gg.add(1);
      const cosine = f64(1).sub(gg).div(divisor), sine = g.mul(2).div(divisor);
      let b0: Node<'f64'>, b1: Node<'f64'>, b2: Node<'f64'>, a0: Node<'f64'>, a1: Node<'f64'>, a2: Node<'f64'>;
      if (config.mode === 'peaking') {
        const alpha = sine.div(f64(q).clamp(.5, 10).mul(2));
        b0 = alpha.mul(A).add(1); b1 = cosine.mul(-2); b2 = f64(1).sub(alpha.mul(A));
        a0 = alpha.div(A).add(1); a1 = b1; a2 = f64(1).sub(alpha.div(A));
      } else {
        // 2*sqrt(A)*alpha, with alpha=sin(w)/sqrt(2) for shelf slope S=1.
        const beta = boundedDbAmplitude(gainDb, 80).mul(Math.SQRT2).mul(sine);
        const plus = A.add(1), minus = A.sub(1);
        if (config.mode === 'lowShelf') {
          b0 = A.mul(plus.sub(minus.mul(cosine)).add(beta));
          b1 = A.mul(minus.sub(plus.mul(cosine))).mul(2);
          b2 = A.mul(plus.sub(minus.mul(cosine)).sub(beta));
          a0 = plus.add(minus.mul(cosine)).add(beta);
          a1 = minus.add(plus.mul(cosine)).mul(-2);
          a2 = plus.add(minus.mul(cosine)).sub(beta);
        } else {
          b0 = A.mul(plus.add(minus.mul(cosine)).add(beta));
          b1 = A.mul(minus.add(plus.mul(cosine))).mul(-2);
          b2 = A.mul(plus.add(minus.mul(cosine)).sub(beta));
          a0 = plus.sub(minus.mul(cosine)).add(beta);
          a1 = minus.sub(plus.mul(cosine)).mul(2);
          a2 = plus.sub(minus.mul(cosine)).sub(beta);
        }
      }
      // Only bounded nonzero coefficients are staged; audio intermediates remain expressions.
      normalization.write(f64(1).div(a0)); const n = normalization.read(), x = f64(input);
      const y = b0.mul(n).mul(x).add(old1);
      z1.write(b1.mul(n).mul(x).sub(a1.mul(n).mul(y)).add(old2).mul(historyScale));
      z2.write(b2.mul(n).mul(x).sub(a2.mul(n).mul(y)).mul(historyScale));
      return f32(y);
    },
  };
});
