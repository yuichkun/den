import { defineSubgraph, f32, f64, select, state, type Node } from '@unworklet/core';

export interface LfoConfig { sampleRate: number }

/**
 * Free-running sine source; tick once per sample. Rate is clamped to [0,20] Hz.
 * Output uses the current phase, then advances by rate/sampleRate. Rate zero
 * holds phase; changing rate never resets phase. Reset emits the supplied phase
 * on that sample and advances from it. Reset phase is in cycles, wrapped to [0,1).
 * f64 phase prevents a small rate from stalling against a large f32 phase.
 * Finite inputs required. No implicit note reset, depth, smoothing or routing.
 */
export const lfo = defineSubgraph((config: LfoConfig) => {
  if (!Number.isInteger(config.sampleRate) || config.sampleRate < 1) {
    throw new RangeError('lfo sampleRate must be a positive integer');
  }
  const phase = state.f64(0).named('phase');
  return {
    tick(rate: Node<'f32'>, reset: Node<'bool'>, resetPhase: Node<'f32'>) {
      const requested = f64(resetPhase);
      const current = select(reset, requested.sub(requested.floor()), phase.read());
      const next = current.add(f64(rate.clamp(0, 20)).div(config.sampleRate));
      phase.write(next.sub(next.floor()));
      // Reflect cycles into [-1/4,1/4] before polynomial evaluation. The
      // degree-13 sine remainder is <= (pi/2)^15 / 15! < 7e-10.
      // unworklet 0.4.1 sin demotes f64 to its f32 degree-9 approximation;
      // direct f64 arithmetic preserves slow phase changes and the error bound.
      const centered = current.sub(select(current.gt(0.5), f64(1), f64(0)));
      const folded = select(centered.gt(0.25), f64(0.5).sub(centered),
        select(centered.lt(-0.25), f64(-0.5).sub(centered), centered));
      const x = folded.mul(2 * Math.PI), x2 = x.mul(x);
      const polynomial = f64(1 / 6227020800).mul(x2).sub(1 / 39916800)
        .mul(x2).add(1 / 362880).mul(x2).sub(1 / 5040)
        .mul(x2).add(1 / 120).mul(x2).sub(1 / 6).mul(x2).add(1);
      return f32(x.mul(polynomial)).clamp(-1, 1);
    },
  };
});

// The musical octave ratio has a bounded exponent [-8,8]. Evaluate exp(x/16)
// through degree 8, then square four times: |x/16| <= ln(2)/2, giving < 5e-9
// relative truncation error. This avoids 0.4.1's approximate f32 pow/log path.
function octaveRatio(octaves: Node<'f32'>) {
  const x = f64(octaves).mul(Math.LN2 / 16);
  const p = f64(1 / 40320).mul(x).add(1 / 5040).mul(x).add(1 / 720)
    .mul(x).add(1 / 120).mul(x).add(1 / 24).mul(x).add(1 / 6)
    .mul(x).add(0.5).mul(x).add(1).mul(x).add(1);
  const p2 = p.mul(p), p4 = p2.mul(p2), p8 = p4.mul(p4);
  return f32(p8.mul(p8));
}

/** Destination-unit depth, with final bounds enforced by the destination. */
export function modulatePitch(baseHz: Node<'f32'>, signal: Node<'f32'>, semitones: Node<'f32'>, maxHz: number) {
  return baseHz.mul(octaveRatio(signal.clamp(-1, 1).mul(semitones.clamp(-24, 24)).div(12))).clamp(0, maxHz);
}
export function modulateCutoff(baseHz: Node<'f32'>, signal: Node<'f32'>, octaves: Node<'f32'>, maxHz: number) {
  return baseHz.mul(octaveRatio(signal.clamp(-1, 1).mul(octaves.clamp(-8, 8)))).clamp(20, maxHz);
}
export function modulateDelay(baseSeconds: Node<'f32'>, signal: Node<'f32'>, depthSeconds: Node<'f32'>, minSeconds: number, maxSeconds: number) {
  return baseSeconds.add(signal.clamp(-1, 1).mul(depthSeconds.clamp(0, 0.05))).clamp(minSeconds, maxSeconds);
}
