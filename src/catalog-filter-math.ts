import { f64, type Node } from '@unworklet/core';

export function checkedSampleRate(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('sampleRate must be finite and in [8000, 192000] Hz');
  }
  return Math.min(20000, 0.45 * sampleRate);
}

// Bounded half-angle Taylor polynomials avoid f32 transcendental lowering in
// unworklet 0.4.1. Same formula as the reviewed initial low-pass, no dependency
// or existing processor/schema change. Domain: [0, .45*pi].
export function tangentHalfAngle(frequency: Node<'f32'>, sampleRate: number, maximum: number) {
  const a = f64(frequency).clamp(20, maximum).mul(Math.PI / sampleRate), z = a.mul(a);
  const sine = a.mul(f64(-1 / 6227020800).mul(z).add(1 / 39916800).mul(z).sub(1 / 362880).mul(z).add(1 / 5040).mul(z).sub(1 / 120).mul(z).add(1 / 6).mul(z).neg().add(1));
  const cosine = f64(-1 / 87178291200).mul(z).add(1 / 479001600).mul(z).sub(1 / 3628800).mul(z).add(1 / 40320).mul(z).sub(1 / 720).mul(z).add(1 / 24).mul(z).sub(1 / 2).mul(z).add(1);
  return sine.div(cosine);
}

// exp(x), |x| <= ln(10)*24/40. Degree 16; no arbitrary exp domain promise.
export function boundedDbAmplitude(db: Node<'f32'>, divisor: number = 40) {
  const x = f64(db).clamp(-24, 24).mul(Math.LN10 / divisor);
  let factorial = 1; const inverse = [1];
  for (let n = 1; n <= 16; n++) {factorial *= n; inverse.push(1 / factorial);}
  let result = f64(inverse[16]);
  for (let n = 15; n >= 0; n--) result = result.mul(x).add(inverse[n]);
  return result;
}
