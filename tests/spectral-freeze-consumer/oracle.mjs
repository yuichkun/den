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
export function maxError(actual, expected) {
  if (actual.length !== expected.length) throw new RangeError('Oracle arrays must have equal lengths');
  let result = 0;
  for (let n = 0; n < actual.length; n++) result = Math.max(result, Math.abs(actual[n] - expected[n]));
  return result;
}
export function rotateSpectrum(captured, elapsed, hop) {
  const size = captured[0].length, real = new Float64Array(size), imag = new Float64Array(size);
  for (let k = 0; k <= size / 2; k++) {
    const angle = 2 * Math.PI * k * elapsed * hop / size;
    const c = Math.cos(angle), s = Math.sin(angle), re = captured[0][k], im = k === 0 || k === size / 2 ? 0 : captured[1][k];
    real[k] = re * c - im * s; imag[k] = re * s + im * c;
    if (k === 0 || k === size / 2) imag[k] = 0;
    else { real[size - k] = real[k]; imag[size - k] = -imag[k]; }
  }
  return [real, imag];
}
export function directFreezeWola(input, resets, freezes, size, hop, mode = 'dft') {
  const output = new Float64Array(input.length + size);
  const window = Float64Array.from({ length: size }, (_, n) => Math.sin(Math.PI * n / size));
  let lastReset = -1, captured = null, capturedAt = 0;
  for (let t = 0; t < input.length; t++) {
    if (resets[t] > 0) { lastReset = t; captured = null; output.fill(0, t); }
    if (t % hop !== 0) continue;
    const frame = Float64Array.from(window, (w, n) => t - size + n > lastReset ? input[t - size + n] * w : 0);
    if (!(freezes[t] > 0) || resets[t] > 0) captured = null;
    else if (!captured) { captured = mode === 'dft' ? directDft(frame, new Float64Array(size)) : frame; capturedAt = t; }
    // Time-domain circular left shift is a separate analytic oracle for the
    // positive bin phase increment. It does not implement the native rotations.
    const samples = captured ? mode === 'dft'
      ? directDft(...rotateSpectrum(captured, (t - capturedAt) / hop, hop), true)[0]
      : Float64Array.from(window, (_, n) => captured[(n + t - capturedAt) % size])
      : frame;
    for (let n = 0; n < size; n++) output[t + n] += samples[n] * window[n] * 2 * hop / size;
    if (resets[t] > 0) output[t] = 0;
  }
  return output.slice(0, input.length);
}
