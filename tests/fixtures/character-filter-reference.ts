// Independently evaluated scalar specification. No production imports or DSL.
export const bounded = (value: number, lo: number, hi: number, fallback: number) =>
  Math.min(hi, Math.max(lo, Number.isNaN(value) ? fallback : value));
export const saturation = (value: number) => value / Math.hypot(1, value);

export function characterReference(rate: number, channels: readonly Float32Array[], initial = [0, 0, 0, 0]) {
  const memory = initial.slice();
  const output = Float64Array.from(channels[0], (input, n) => {
    if (channels[4][n] > 0) memory.fill(0);
    const hz = bounded(channels[1][n], 20, Math.min(20000, rate / 5), 20);
    const pole = Math.exp(-2 * Math.PI * hz / rate);
    const drive = bounded(channels[3][n], 0, 16, 1);
    const feedback = 4 * bounded(channels[2][n], 0, 1, 0);
    let value = bounded(input, -8, 8, 0) * drive - feedback * memory[3];
    for (let stage = 0; stage < 4; stage++) {
      // Exponential interpolation instead of the production's convex form.
      const target = saturation(value);
      value = target + pole * (memory[stage] - target);
      memory[stage] = value;
    }
    return value;
  });
  return { output, state: memory };
}

// Independent small-signal direct-form transfer:
// a^4 / [(1 - b z^-1)^4 + 4 resonance a^4 z^-1].
// Intended for normal pole frequencies: direct-form cancellation is not an
// accurate oracle at a nearly repeated DC pole or arbitrarily long records.
export function linearReference(input: Float32Array, rate: number, hz: number, resonance: number, drive = 1) {
  const a = -Math.expm1(-2 * Math.PI * hz / rate), b = 1 - a;
  const denominator = [-4 * b + 4 * resonance * a ** 4, 6 * b ** 2, -4 * b ** 3, b ** 4];
  const history = [0, 0, 0, 0];
  return Float64Array.from(input, x => {
    let y = drive * a ** 4 * x;
    for (let k = 0; k < 4; k++) y -= denominator[k] * history[k];
    history.unshift(y); history.pop();
    return y;
  });
}

export function dcReference(input: number, resonance: number, drive: number) {
  const pass = (feedback: number) => {
    let value = bounded(input, -8, 8, 0) * bounded(drive, 0, 16, 1) - 4 * bounded(resonance, 0, 1, 0) * feedback;
    for (let i = 0; i < 4; i++) value = saturation(value);
    return value;
  };
  // y - pass(y) is strictly increasing. Bisection is a static independent
  // equation solver, not the DSP's sample recurrence or coefficient design.
  let lower = -1, upper = 1;
  for (let i = 0; i < 80; i++) {
    const middle = (lower + upper) / 2;
    if (middle > pass(middle)) upper = middle; else lower = middle;
  }
  return (lower + upper) / 2;
}

export function projection(signal: ArrayLike<number>, bin: number) {
  let real = 0, imaginary = 0;
  for (let n = 0; n < signal.length; n++) {
    const angle = 2 * Math.PI * bin * n / signal.length;
    real += signal[n] * Math.cos(angle); imaginary -= signal[n] * Math.sin(angle);
  }
  return { real: 2 * real / signal.length, imaginary: 2 * imaginary / signal.length,
    amplitude: 2 * Math.hypot(real, imaginary) / signal.length };
}

// After warmup on a coherent periodic input, remove DC and only the input's
// legal harmonics below Nyquist. Remaining RMS includes folded nonlinear
// harmonics and floating-point noise. This is not an oversampled gold standard.
export function foldedResidual(signal: ArrayLike<number>, bin: number) {
  const mean = Array.from(signal).reduce((a, b) => a + b, 0) / signal.length;
  const residual = Float64Array.from(signal, x => x - mean);
  for (let harmonic = 1; harmonic * bin < signal.length / 2; harmonic++) {
    const p = projection(signal, harmonic * bin);
    for (let n = 0; n < signal.length; n++) {
      const angle = 2 * Math.PI * harmonic * bin * n / signal.length;
      residual[n] -= p.real * Math.cos(angle) - p.imaginary * Math.sin(angle);
    }
  }
  return Math.sqrt(residual.reduce((sum, x) => sum + x * x, 0) / signal.length);
}
