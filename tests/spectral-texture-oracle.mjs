// Independent dense DFT and absolute-time overlap addition. No den DSP, radix-2
// FFT, native buffer, cursor, state, or scheduler implementation is reused.
const matrices = new Map();
export function directDft(real, imag, inverse = false) {
  const size = real.length;
  if (!matrices.has(size)) {
    const cosine = new Float64Array(size * size), sine = new Float64Array(size * size);
    for (let k = 0; k < size; k++) for (let n = 0; n < size; n++) {
      cosine[k * size + n] = Math.cos(2 * Math.PI * k * n / size);
      sine[k * size + n] = Math.sin(2 * Math.PI * k * n / size);
    }
    matrices.set(size, { cosine, sine });
  }
  const { cosine, sine } = matrices.get(size), sign = inverse ? 1 : -1;
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    let r = 0, i = 0;
    for (let n = 0; n < size; n++) {
      const c = cosine[k * size + n], s = sign * sine[k * size + n];
      r += real[n] * c - imag[n] * s; i += real[n] * s + imag[n] * c;
    }
    re[k] = r / (inverse ? size : 1); im[k] = i / (inverse ? size : 1);
  }
  return [re, im];
}
export function maxError(actual, expected) {
  if (actual.length !== expected.length) throw new RangeError('Oracle arrays must have equal lengths');
  let result = 0;
  for (let n = 0; n < actual.length; n++) result = Math.max(result, Math.abs(actual[n] - expected[n]));
  return result;
}

export const sanitizeAmount = value => Number.isNaN(value) ? 0 : Math.min(1, Math.max(0, value));

export function blurSpectrum(spectrum, radius, amount, relativeFloor = 2 ** -20) {
  const [real, imag] = spectrum, size = real.length, half = size / 2;
  const magnitude = Float64Array.from(real, (re, k) => Math.hypot(re, k === 0 || k === half ? 0 : imag[k]));
  const peak = Math.max(...magnitude), mix = sanitizeAmount(amount);
  if (mix === 0) return [real.slice(), imag.slice()];
  const output = [new Float64Array(size), new Float64Array(size)];
  for (let k = 0; k <= half; k++) {
    let sum = 0;
    // Two equal box convolutions produce the normalized triangular kernel.
    for (let a = 0; a <= radius; a++) for (let b = 0; b <= radius; b++) sum += magnitude[(k + a - b + size) % size];
    const target = magnitude[k] * (1 - mix) + sum / (radius + 1) ** 2 * mix;
    const phase = magnitude[k] > 0 && magnitude[k] >= peak * relativeFloor ? Math.atan2(k === 0 || k === half ? 0 : imag[k], real[k]) : 0;
    output[0][k] = target * Math.cos(phase);
    output[1][k] = k === 0 || k === half ? 0 : target * Math.sin(phase);
    if (k > 0 && k < half) { output[0][size - k] = output[0][k]; output[1][size - k] = -output[1][k]; }
  }
  return output;
}

export function crossSpectrum(carrier, modulator, maxGain, amount) {
  const size = carrier[0].length, half = size / 2, mix = sanitizeAmount(amount);
  if (mix === 0) return carrier.map(plane => plane.slice());
  const output = [new Float64Array(size), new Float64Array(size)];
  for (let k = 0; k <= half; k++) {
    const re = carrier[0][k], im = k === 0 || k === half ? 0 : carrier[1][k];
    const a = Math.hypot(re, im), b = Math.hypot(modulator[0][k], k === 0 || k === half ? 0 : modulator[1][k]);
    const target = (1 - mix) * a + mix * Math.min(b, a * maxGain);
    const phase = a > 0 ? Math.atan2(im, re) : 0;
    output[0][k] = target * Math.cos(phase); output[1][k] = k === 0 || k === half ? 0 : target * Math.sin(phase);
    if (k > 0 && k < half) { output[0][size - k] = output[0][k]; output[1][size - k] = -output[1][k]; }
  }
  return output;
}

export function directTextureWola(inputs, size, hop, mode, option) {
  const [carrier, modulator, amount, resets] = inputs, output = new Float64Array(carrier.length + size);
  const window = Float64Array.from({ length: size }, (_, n) => Math.sin(Math.PI * n / size));
  let lastReset = -1;
  for (let t = 0; t < carrier.length; t++) {
    if (resets[t] > 0) { lastReset = t; output.fill(0, t); }
    if (t % hop !== 0) continue;
    const analyze = input => directDft(Float64Array.from(window, (w, n) => t - size + n > lastReset ? input[t - size + n] * w : 0), new Float64Array(size));
    const spectrum = mode === 'blur' ? blurSpectrum(analyze(carrier), option, amount[t]) : crossSpectrum(analyze(carrier), analyze(modulator), option, amount[t]);
    const frame = directDft(...spectrum, true)[0];
    for (let n = 0; n < size; n++) output[t + n] += frame[n] * window[n] * 2 * hop / size;
    if (resets[t] > 0) output[t] = 0;
  }
  return output.slice(0, carrier.length);
}
