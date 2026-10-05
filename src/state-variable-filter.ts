import { defineSubgraph, f32, f64, select, state, type Node } from '@unworklet/core';
import { checkedSampleRate, tangentHalfAngle } from './catalog-filter-math.js';

export interface StateVariableFilterConfig { sampleRate: number }
export interface StateVariableFilterOutput {
  lowpass: Node<'f32'>;
  /** Constant-peak bandpass: unity at center, independent of Q. */
  bandpass: Node<'f32'>;
  highpass: Node<'f32'>;
  notch: Node<'f32'>;
  allpass: Node<'f32'>;
}

/** Linear TPT SVF. One shared two-integrator history produces five responses. */
export const stateVariableFilter = defineSubgraph((config: StateVariableFilterConfig) => {
  const maximum = checkedSampleRate(config.sampleRate);
  // Fixed scaling keeps f32 subnormal histories above the upstream <1e-30 state-write flush.
  // Even full-scale f32 inputs remain far below f64 overflow after scaling.
  const historyScale = 2 ** 128;
  const band = state.f64(0).named('band'), low = state.f64(0).named('low');
  return {
    /** Exactly one tick/sample. Cutoff Hz and Q are clamped; reset clears history before this input. */
    tick(input: Node<'f32'>, cutoffHz: Node<'f32'>, q: Node<'f32'>, reset: Node<'bool'>): StateVariableFilterOutput {
      const s1 = select(reset, f64(0), band.read().div(historyScale)), s2 = select(reset, f64(0), low.read().div(historyScale));
      // This bounded coefficient is scratch storage only, overwritten before use.
      band.write(tangentHalfAngle(cutoffHz, config.sampleRate, maximum));
      const g = band.read(), k = f64(1).div(f64(q).clamp(.5, 10)), x = f64(input);
      const v1 = s1.add(g.mul(x.sub(s2))).div(g.mul(g.add(k)).add(1));
      const v2 = s2.add(g.mul(v1));
      band.write(v1.mul(2).sub(s1).mul(historyScale)); low.write(v2.mul(2).sub(s2).mul(historyScale));
      const normalizedBand = k.mul(v1);
      return {lowpass: f32(v2), bandpass: f32(normalizedBand), highpass: f32(x.sub(normalizedBand).sub(v2)), notch: f32(x.sub(normalizedBand)), allpass: f32(x.sub(normalizedBand.mul(2)))};
    },
  };
});
