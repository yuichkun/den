// Independent RBJ direct-form-I bandpass and direct exponential ballistics.
// Production uses TPT integrators and a bounded coefficient polynomial.
export function coefficients(rate, band) {
  const center = Math.min(Math.max(Math.fround(band.frequencyHz), 20), Math.min(20000, .45 * rate));
  const q = Math.min(Math.max(Math.fround(band.q), .5), 10), angle = 2 * Math.PI * center / rate;
  const alpha = Math.sin(angle) / (2 * q), denominator = 1 + alpha;
  return { b0: alpha / denominator, b2: -alpha / denominator, a1: -2 * Math.cos(angle) / denominator, a2: (1 - alpha) / denominator };
}
export function magnitude(rate, band, hz) {
  const { b0, b2, a1, a2 } = coefficients(rate, band), angle = 2 * Math.PI * hz / rate;
  return Math.hypot(b0 + b2 * Math.cos(2 * angle), -b2 * Math.sin(2 * angle)) /
    Math.hypot(1 + a1 * Math.cos(angle) + a2 * Math.cos(2 * angle), -a1 * Math.sin(angle) - a2 * Math.sin(2 * angle));
}
function bandpass(rate, band) {
  const c = coefficients(rate, band); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (input, reset) => {
    if (reset) x1 = x2 = y1 = y2 = 0;
    const x = Number.isFinite(input) ? input : 0;
    const y = c.b0 * x + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return Math.fround(y);
  };
}
export function reference(config, [modulator, carrier, attack, release, reset]) {
  const banks = config.bands.map(b => ({ a: bandpass(config.sampleRate, b), c: bandpass(config.sampleRate, b), level: 0, gain: b.gain }));
  const output = new Float32Array(modulator.length), envelopes = banks.map(() => new Float32Array(modulator.length));
  for (let n = 0; n < output.length; n++) {
    let sum = 0;
    for (const [i, band] of banks.entries()) {
      const clear = reset[n] > 0, analysis = band.a(modulator[n], clear), synthesis = band.c(carrier[n], clear);
      if (clear) band.level = 0;
      const target = Math.abs(analysis);
      let time = target > band.level ? attack[n] : release[n];
      time = Number.isFinite(time) ? Math.min(30, Math.max(0, time)) : 0;
      const coefficient = time === 0 ? 1 : -Math.expm1(-1 / Math.max(1, time * config.sampleRate));
      band.level = (1 - coefficient) * band.level + coefficient * target;
      envelopes[i][n] = band.level;
      sum += band.gain * synthesis * envelopes[i][n];
    }
    output[n] = sum;
  }
  return [output, ...envelopes];
}
export function maxError(a, b) {
  if (a.length !== b.length) throw new Error('Oracle length mismatch');
  let maximum = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new Error(`Nonfinite sample ${i}`);
    maximum = Math.max(maximum, Math.abs(a[i] - b[i]));
  }
  return maximum;
}
export function rms(input, start = 0) {
  let energy = 0; for (let n = start; n < input.length; n++) energy += input[n] ** 2;
  return Math.sqrt(energy / (input.length - start));
}
export function mean(input, start = 0) {
  let sum = 0; for (let n = start; n < input.length; n++) sum += input[n];
  return sum / (input.length - start);
}
export function signal(rate, n = 8192) {
  const controls = [new Float32Array(n), new Float32Array(n), new Float32Array(n).fill(.003), new Float32Array(n).fill(.019), new Float32Array(n)];
  let seed = 610;
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    controls[0][i] = (i < n * .75 ? .45 * Math.sin(2 * Math.PI * 701.3 * i / rate) + .1 * (seed / 2 ** 32 * 2 - 1) : 0);
    controls[1][i] = .3 * Math.sin(2 * Math.PI * 803 * i / rate) + .2 * Math.sin(2 * Math.PI * 2397 * i / rate);
  }
  for (const i of [127, 128, 129, 1025, 4095, 4096]) if (i < n) controls[4][i] = 1;
  for (const i of [0, 255, 256, 511, 512, 1023, 1024, 4097]) if (i < n) {
    controls[2].fill(i % 2 ? 0 : .001, i); controls[3].fill(i % 3 ? .04 : 30, i);
  }
  return controls;
}
