// Independent scalar interpolation and segmented Simpson integration.
// Do not import DSP implementation, primitives, or generated coefficients.
export const bound = (x: number, low: number, high: number) => Math.max(low, Math.min(high, Number.isNaN(x) ? 0 : x));
export function interpolateCurve(x: number, raw: readonly number[]): number {
  const y = raw.map(v => bound(v, -1, 1));
  if (x <= -1) return y[0];
  if (x >= 1) return y.at(-1)!;
  const position = (x + 1) * (y.length - 1) / 2;
  const index = Math.min(y.length - 2, Math.floor(position));
  return y[index] * (1 - (position - index)) + y[index + 1] * (position - index);
}
export function averageCurve(a: number, b: number, ordinates: readonly number[]): number {
  if (a === b) return interpolateCurve(a, ordinates);
  const low = Math.min(a, b), high = Math.max(a, b);
  const cuts = [low, ...ordinates.map((_, i) => -1 + 2 * i / (ordinates.length - 1)).filter(x => x > low && x < high), high];
  let area = 0;
  for (let i = 1; i < cuts.length; i++) {
    const left = cuts[i - 1], right = cuts[i];
    area += (right - left) * (interpolateCurve(left, ordinates) + 4 * interpolateCurve((left + right) / 2, ordinates) + interpolateCurve(right, ordinates)) / 6;
  }
  return area / (high - low);
}
export function curveShaperReference(input: readonly Float32Array[], quality: 'direct' | 'adaa') {
  const [audio, gain, mix, reset, ...ordinates] = input;
  let last = 0, lastDry = 0;
  return Float32Array.from(audio, (value, i) => {
    if (reset[i] > 0) { last = 0; lastDry = 0; }
    const dry = bound(value, -8, 8), x = dry * bound(gain[i], 0, 32);
    const y = ordinates.map(ch => ch[i]);
    const wet = quality === 'direct' ? interpolateCurve(x, y) : averageCurve(last, x, y);
    const aligned = quality === 'direct' ? dry : (dry + lastDry) / 2;
    last = x; lastDry = dry;
    const blend = bound(mix[i], 0, 1);
    return aligned * (1 - blend) + wet * blend;
  });
}
