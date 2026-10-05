// Independent dense O(N^2) DFT; no radix-2 FFT, den imports or ring-buffer state.
const matrices = new Map();
function matrix(size) {
  if (!matrices.has(size)) {
    const cosine = new Float64Array(size * size), sine = new Float64Array(size * size);
    for (let k = 0; k < size; k++) for (let n = 0; n < size; n++) {
      cosine[k * size + n] = Math.cos(2 * Math.PI * k * n / size);
      sine[k * size + n] = Math.sin(2 * Math.PI * k * n / size);
    }
    matrices.set(size, { cosine, sine });
  }
  return matrices.get(size);
}
export function directDft(real, imag, inverse = false) {
  const size = real.length, { cosine, sine } = matrix(size), sign = inverse ? 1 : -1;
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
export function controls(threshold, floor) {
  return [Number.isNaN(threshold) ? 0 : Math.min(3.4028234663852886e38, Math.max(0, threshold)),
    Number.isNaN(floor) ? 1 : Math.min(1, Math.max(0, floor))];
}
export function gateFrame(frame, threshold, floor) {
  const size = frame.length, windowSum = Array.from({ length: size }, (_, n) => Math.sin(Math.PI * n / size)).reduce((a, b) => a + b, 0);
  const spectrum = directDft(frame, new Float64Array(size)), gains = new Float64Array(size / 2 + 1);
  [threshold, floor] = controls(threshold, floor);
  for (let k = 0; k <= size / 2; k++) {
    const amplitude = Math.hypot(spectrum[0][k], spectrum[1][k]) / windowSum * (k === 0 || k === size / 2 ? 1 : 2);
    gains[k] = amplitude >= threshold ? 1 : floor;
  }
  if (threshold !== 0 && floor !== 1) for (let k = 0; k <= size / 2; k++) {
    spectrum[0][k] *= gains[k]; spectrum[1][k] *= gains[k];
    if (k === 0 || k === size / 2) spectrum[1][k] = 0;
    else { spectrum[0][size - k] = spectrum[0][k]; spectrum[1][size - k] = -spectrum[1][k]; }
  }
  return { spectrum, gains, samples: directDft(...spectrum, true) };
}
export function directGateWola(input, resets, thresholds, floors, size, hop) {
  const output = new Float64Array(input.length + size), window = Float64Array.from({ length: size }, (_, n) => Math.sin(Math.PI * n / size));
  let lastReset = -1;
  for (let t = 0; t < input.length; t++) {
    if (resets[t] > 0) { lastReset = t; output.fill(0, t); }
    if (t % hop !== 0) continue;
    const frame = Float64Array.from(window, (w, n) => t - size + n > lastReset ? input[t - size + n] * w : 0);
    const { samples } = gateFrame(frame, thresholds[t], floors[t]);
    for (let n = 0; n < size; n++) output[t + n] += samples[0][n] * window[n] * 2 * hop / size;
    if (resets[t] > 0) output[t] = 0;
  }
  return output.slice(0, input.length);
}
export function maxError(actual, expected) {
  let result = 0;
  for (let n = 0; n < actual.length; n++) result = Math.max(result, Math.abs(actual[n] - expected[n]));
  return result;
}
