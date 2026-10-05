import { defineSubgraph, f32, f64, instantiate, select, state, type Node } from '@unworklet/core';
import { delayReadhead } from './delay-readhead.js';

export interface AlgorithmicReverbConfig {
  sampleRate: number;
  /** Fixed delay-time scale, [0.5, 2]. Default 1. Rebuild to change. */
  roomScale?: number;
  /** Nominal loop-gain loss time in seconds, [0.1, 10]. Default 1.5.
   * Not an exact RT60 or hard tail-duration ceiling: very low damping adds
   * loop group delay and can lengthen low-band decay. Rebuild to change. */
  decaySeconds?: number;
  /** Fixed one-pole loop lowpass corner, [20, 0.45*sampleRate]. Default min(6000, 0.45*sampleRate). */
  dampingHz?: number;
}
export interface ReverbControls {
  mix: Node<'f32'>;
  /** Dry output, no new input; existing tail continues internally. */
  bypass: Node<'bool'>;
  reset: Node<'bool'>;
}

/** Four-line Hadamard FDN candidate. Fixed capacities and coefficients, no FFT.
 * Finite inputs required. No predelay; the shortest network delay precedes wet audio.
 */
export const algorithmicReverb = defineSubgraph((config: AlgorithmicReverbConfig) => {
  const { sampleRate, roomScale = 1, decaySeconds = 1.5 } = config;
  const dampingHz = config.dampingHz ?? Math.min(6000, 0.45 * sampleRate);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      !Number.isFinite(roomScale) || roomScale < 0.5 || roomScale > 2 ||
      !Number.isFinite(decaySeconds) || decaySeconds < 0.1 || decaySeconds > 10 ||
      !Number.isFinite(dampingHz) || dampingHz < 20 || dampingHz > 0.45 * sampleRate) {
    throw new RangeError('algorithmicReverb requires sample rate [8000,192000], roomScale [0.5,2], decaySeconds [0.1,10], dampingHz [20,0.45*sampleRate]');
  }
  // Incommensurate reference lengths (seconds), rounded to fixed sample counts.
  const lengths = [0.0297, 0.0371, 0.0411, 0.0437].map(seconds => Math.round(seconds * roomScale * sampleRate));
  const lines = lengths.map((length, i) => ({
    delay: instantiate(delayReadhead, { sampleRate, maxDelaySeconds: length / sampleRate }, { name: `line${i}` }),
    seconds: length / sampleRate,
    gain: 10 ** (-3 * length / (sampleRate * decaySeconds)),
    damping: state.f64(0).named(`damping${i}`),
    wet: state.f64(0).expose({ name: `wet${i}`, snapshot: 'transient' }),
  }));
  // One-pole matched-z lowpass: convex combination, unity DC, no added resonance.
  const pole = Math.exp(-2 * Math.PI * dampingHz / sampleRate);
  // H/2 is orthogonal. These literal rows also keep generated work fixed.
  const matrix = [[1, 1, 1, 1], [1, -1, 1, -1], [1, 1, -1, -1], [1, -1, -1, 1]];
  return {
    tick(inputLeft: Node<'f32'>, inputRight: Node<'f32'>, c: ReverbControls) {
      const heads = lines.map(line => line.delay.read(f32(line.seconds), c.reset));
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        line.wet.write(f64(heads[i].output));
        line.damping.write(select(c.reset, f64(0), line.damping.read()).mul(pole).add(line.wet.read().mul(1 - pole)));
      }
      const damped = lines.map(line => line.damping.read().mul(line.gain));
      const left = f64(select(c.bypass, f32(0), inputLeft)), right = f64(select(c.bypass, f32(0), inputRight));
      for (let i = 0; i < lines.length; i++) {
        const injection = left.add(right.mul(matrix[1][i])).mul(0.5);
        const feedback = damped.reduce((sum, x, j) => sum.add(x.mul(matrix[i][j] * 0.5)), f64(0));
        heads[i].write(f32(injection.add(feedback)));
      }
      const wetLeft = lines.reduce((sum, line, i) => sum.add(line.wet.read().mul(matrix[2][i] * 0.5)), f64(0));
      const wetRight = lines.reduce((sum, line, i) => sum.add(line.wet.read().mul(matrix[3][i] * 0.5)), f64(0));
      const mix = f64(c.mix).clamp(0, 1);
      return {
        left: select(c.bypass, inputLeft, f32(f64(inputLeft).mul(f64(1).sub(mix)).add(wetLeft.mul(mix)))),
        right: select(c.bypass, inputRight, f32(f64(inputRight).mul(f64(1).sub(mix)).add(wetRight.mul(mix)))),
      };
    },
  };
});
