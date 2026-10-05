// Independent host math. No imports from the DSP implementation.
export const bound = (x: number, lo: number, hi: number, fallback = 0) => Math.max(lo, Math.min(hi, Number.isNaN(x) ? fallback : x));
export const wrap = (x: number) => x - Math.floor(x);
export function cycleRead(data: Float32Array, length: number, frame: number, phase: number) {
  const p = wrap(phase) * length, n = Math.floor(p), t = p - n;
  const a = data[frame * length + n], b = data[frame * length + (n + 1) % length];
  return Math.fround((Number.isFinite(a) ? a : 0) * (1 - t) + (Number.isFinite(b) ? b : 0) * t);
}
export function tableReference(data: Float32Array, rate: number, length: number, count: number, controls: Float32Array[], initial = 0) {
  let phase = initial;
  return Float32Array.from(controls[0], (_, n) => {
    if (controls[2][n]) phase = initial;
    const frame = bound(controls[1][n], 0, count - 1), lo = Math.floor(frame), hi = Math.min(lo + 1, count - 1), mix = frame - lo;
    const value = cycleRead(data, length, lo, phase) * (1 - mix) + cycleRead(data, length, hi, phase) * mix;
    phase = wrap(phase + bound(controls[0][n], 0, .45 * rate) / rate);
    return value;
  });
}

/** Exact piecewise-polynomial quadrature of the raw waveform convolved with a
 * unit-area triangular kernel. Distinct from local BLEP/BLAMP correction code. */
export function smoothedWave(wave: 'pulse' | 'triangle', phase: number, step: number, duty: number) {
  const raw = (t: number) => wave === 'pulse' ? (wrap(t) < duty ? 1 : -1) : 1 - 4 * Math.abs(wrap(t) - .5);
  if (step === 0) return raw(phase);
  const boundaries = [-step, 0, step];
  for (let cycle = -2; cycle <= 2; cycle++) for (const edge of [cycle, cycle + (wave === 'pulse' ? duty : .5)]) {
    const t = phase - edge;
    if (t > -step && t < step) boundaries.push(t);
  }
  boundaries.sort((a, b) => a - b);
  let integral = 0;
  for (let i = 1; i < boundaries.length; i++) {
    const half = (boundaries[i] - boundaries[i - 1]) / 2, middle = (boundaries[i] + boundaries[i - 1]) / 2;
    for (const sign of [-1, 1]) {
      const t = middle + sign * half / Math.sqrt(3);
      integral += half * raw(phase - t) * (1 - Math.abs(t) / step) / step;
    }
  }
  return integral;
}
export function vaReference(wave: 'pulse' | 'triangle', rate: number, controls: Float32Array[], initial = 0) {
  let phase = initial;
  return Float32Array.from(controls[0], (_, n) => {
    if (controls[2][n]) phase = initial;
    const step = bound(controls[0][n], 0, .45 * rate) / rate;
    const value = smoothedWave(wave, phase, step, bound(controls[1][n], 0, 1, .5));
    phase = wrap(phase + step);
    return value;
  });
}
export function noiseReference(seed: number, resets: Float32Array) {
  let current = BigInt(seed);
  return Float32Array.from(resets, reset => {
    if (reset) current = BigInt(seed);
    current = current * 48271n % 2147483647n;
    return 2 * Number(current) / 2147483647 - 1;
  });
}
export function bin(samples: Float32Array, frequencyBin: number) {
  let re = 0, im = 0;
  samples.forEach((x, n) => { const a = 2 * Math.PI * frequencyBin * n / samples.length; re += x * Math.cos(a); im -= x * Math.sin(a); });
  return { re: re / samples.length, im: im / samples.length, magnitude: 2 * Math.hypot(re, im) / samples.length };
}
/** Complex Fourier coefficients, independently folded onto the sampled bin. */
export function foldedCoefficient(wave: 'pulse' | 'triangle', frames: number, frequencyBin: number, target: number, duty: number, smooth: boolean) {
  let re = target === 0 && wave === 'pulse' ? 2 * duty - 1 : 0, im = 0;
  for (let k = -4096; k <= 4096; k++) {
    if (!k || ((k * frequencyBin) % frames + frames) % frames !== target) continue;
    const x = Math.PI * k * frequencyBin / frames, gain = smooth ? (Math.sin(x) / x) ** 2 : 1;
    if (wave === 'pulse') {
      const a = Math.PI * k * duty, amplitude = 2 * Math.sin(a) / (Math.PI * k) * gain;
      re += amplitude * Math.cos(a); im -= amplitude * Math.sin(a);
    } else if (Math.abs(k) % 2) re -= 4 * gain / (Math.PI * k) ** 2;
  }
  return { re, im, magnitude: 2 * Math.hypot(re, im) };
}
