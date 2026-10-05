import type { DriveCurve } from '../../src/drive.js';

// Scalar reference curves. Fold uses trigonometry rather than the DSP's modulo.
export function curveValue(x: number, curve: DriveCurve): number {
  if (curve === 'hard') return Math.max(-1, Math.min(1, x));
  if (curve === 'fold') return 2 / Math.PI * Math.asin(Math.sin(Math.PI * x / 2));
  const cubic = (v: number) => Math.abs(v) >= 1 ? Math.sign(v) : (3 * v - v ** 3) / 2;
  return curve === 'asymmetric' && x < 0 ? cubic(2 * x) / 2 : cubic(x);
}

// Integrate the linearly interpolated input with Simpson quadrature, splitting
// at known knots. Simpson is exact for the cubic/linear pieces. This oracle
// never uses the implementation's antiderivatives or small-difference branch.
export function intervalAverage(a: number, b: number, curve: DriveCurve) {
  if (a === b) return curveValue(a, curve);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const knots = curve === 'fold'
    ? Array.from({ length: Math.ceil((hi - lo) / 2) + 2 }, (_, i) => 2 * Math.ceil((lo - 1) / 2) + 1 + 2 * i)
    : curve === 'asymmetric' ? [-0.5, 0, 1] : [-1, 1];
  const points = [lo, ...knots.filter(x => x > lo && x < hi), hi];
  let sum = 0;
  for (let i = 1; i < points.length; i++) {
    const left = points[i - 1], right = points[i];
    sum += (right - left) / 6 * (curveValue(left, curve) + 4 * curveValue((left + right) / 2, curve) + curveValue(right, curve));
  }
  return sum / (hi - lo);
}

export function driveReference(input: Float32Array, gain: Float32Array, mix: Float32Array, reset: Float32Array, curve: DriveCurve, quality: 'direct' | 'adaa') {
  let previous = 0, dryPrevious = 0;
  return Float32Array.from(input, (v, i) => {
    if (reset[i] > 0) { previous = 0; dryPrevious = 0; }
    const dry = Math.max(-8, Math.min(8, Number.isNaN(v) ? 0 : v));
    const x = dry * Math.max(0, Math.min(32, Number.isNaN(gain[i]) ? 0 : gain[i]));
    const wet = quality === 'adaa' ? intervalAverage(previous, x, curve) : curveValue(x, curve);
    const alignedDry = quality === 'adaa' ? (dryPrevious + dry) / 2 : dry;
    const blend = Math.max(0, Math.min(1, Number.isNaN(mix[i]) ? 0 : mix[i]));
    previous = x; dryPrevious = dry;
    return alignedDry * (1 - blend) + wet * blend;
  });
}

export function amplitude(signal: Float32Array, bin: number) {
  let re = 0, im = 0;
  for (let i = 0; i < signal.length; i++) {
    re += signal[i] * Math.cos(2 * Math.PI * bin * i / signal.length);
    im += signal[i] * Math.sin(2 * Math.PI * bin * i / signal.length);
  }
  return 2 * Math.hypot(re, im) / signal.length;
}
export function aliasResidual(signal: Float32Array, bin: number) {
  const residual = Float64Array.from(signal), n = signal.length;
  const mean = signal.reduce((s, x) => s + x, 0) / n;
  for (let i = 0; i < n; i++) residual[i] -= mean;
  for (let harmonic = 1; harmonic * bin < n / 2; harmonic++) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const angle = 2 * Math.PI * harmonic * bin * i / n;
      re += signal[i] * Math.cos(angle) * 2 / n;
      im += signal[i] * Math.sin(angle) * 2 / n;
    }
    for (let i = 0; i < n; i++) {
      const angle = 2 * Math.PI * harmonic * bin * i / n;
      residual[i] -= re * Math.cos(angle) + im * Math.sin(angle);
    }
  }
  return Math.sqrt(residual.reduce((s, x) => s + x * x, 0) / n);
}
