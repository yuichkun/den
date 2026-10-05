import { defineSubgraph, f32, f64, select, state, type Node } from '@unworklet/core';
import { boundedDbAmplitude, checkedSampleRate, tangentHalfAngle } from './catalog-filter-math.js';

export type BiquadEqMode = 'peaking' | 'lowShelf' | 'highShelf';
export interface BiquadEqConfig { sampleRate: number; mode: BiquadEqMode }

/** RBJ-equivalent responses realized with a linear TPT SVF; shelves use S=1. */
export const biquadEq = defineSubgraph((config: BiquadEqConfig) => {
  const maximum = checkedSampleRate(config.sampleRate);
  if (!['peaking','lowShelf','highShelf'].includes(config.mode)) throw new TypeError('Unknown biquad EQ mode');
  const historyScale = 2 ** 128; // Preserve f32 histories through upstream scalar-state flush.
  const band = state.f64(0).named('band'), low = state.f64(0).named('low');
  const tangent = state.f64(0).named('coefficientG'), amplitude = state.f64(1).named('coefficientA');
  return {
    /** Cutoff [20,min(20000,.45*fs)], Q [.5,10], gain [-24,24] dB. Q is unused by S=1 shelves. */
    tick(input: Node<'f32'>, cutoffHz: Node<'f32'>, q: Node<'f32'>, gainDb: Node<'f32'>, reset: Node<'bool'>) {
      const s1 = select(reset, f64(0), band.read().div(historyScale));
      const s2 = select(reset, f64(0), low.read().div(historyScale));
      amplitude.write(boundedDbAmplitude(gainDb));
      const A = amplitude.read(), baseG = tangentHalfAngle(cutoffHz, config.sampleRate, maximum);
      const sqrtA = boundedDbAmplitude(gainDb, 80);
      tangent.write(config.mode === 'lowShelf' ? baseG.div(sqrtA) : config.mode === 'highShelf' ? baseG.mul(sqrtA) : baseG);
      const g = tangent.read(), x = f64(input);
      const k = config.mode === 'peaking' ? f64(1).div(f64(q).clamp(.5,10).mul(A)) : f64(Math.SQRT2);
      const v1 = s1.add(g.mul(x.sub(s2))).div(g.mul(g.add(k)).add(1));
      const v2 = s2.add(g.mul(v1));
      band.write(v1.mul(2).sub(s1).mul(historyScale));
      low.write(v2.mul(2).sub(s2).mul(historyScale));
      // x + mixed SVF responses. This avoids a time-varying direct-form
      // realization whose changing coefficients can pump its state to overflow.
      if (config.mode === 'peaking') return f32(x.add(k.mul(A.mul(A).sub(1)).mul(v1)));
      if (config.mode === 'lowShelf') return f32(x.add(k.mul(A.sub(1)).mul(v1)).add(A.mul(A).sub(1).mul(v2)));
      return f32(A.mul(A).mul(x).add(k.mul(A).mul(f64(1).sub(A)).mul(v1)).add(f64(1).sub(A.mul(A)).mul(v2)));
    },
  };
});
