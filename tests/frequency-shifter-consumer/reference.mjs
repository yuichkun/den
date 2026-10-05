// Independent absolute-time convolution and Math.sin/cos, never DSP imports.
// The kernel is the inverse DTFT of -i*sign(omega), windowed and delayed.
export const kernel = Array.from({ length: 63 }, (_, n) => {
  const k = n - 31;
  if (n === 0 || n === 62 || k === 0) return 0;
  const inverseDtft = (1 - Math.cos(Math.PI * k)) / (Math.PI * k);
  const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / 62) + 0.08 * Math.cos(4 * Math.PI * n / 62);
  return inverseDtft * window;
});
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export function reference(rate, channels) {
  let phase = 0, earliest = 0;
  return Float32Array.from(channels[0], (_, n) => {
    if (channels[4][n] > 0) { phase = 0; earliest = n + 1; return 0; }
    const dry = n - 31 >= earliest ? channels[0][n - 31] : 0;
    let imaginary = 0;
    for (let k = 0; k < kernel.length; k++) if (n - k >= earliest) imaginary += kernel[k] * channels[0][n - k];
    const wet = dry * Math.cos(2 * Math.PI * phase) - imaginary * Math.sin(2 * Math.PI * phase);
    phase += clamp(channels[1][n], -rate / 4, rate / 4) / rate;
    phase -= Math.floor(phase);
    const mix = clamp(channels[2][n], 0, 1);
    return channels[3][n] > 0 ? dry : dry * (1 - mix) + wet * mix;
  });
}
export function ports(rate, frames, edits = {}) {
  const defaults = [n => Math.sin(0.317 * n) * 0.45 + Math.cos(0.883 * n) * 0.35, rate / 32, 1, 0, 0];
  return defaults.map((fallback, ch) => Float32Array.from({ length: frames }, (_, n) => {
    const value = edits[ch] ?? fallback;
    return typeof value === 'function' ? value(n) : value;
  }));
}
export function maxError(actual, expected) {
  if (actual.length !== expected.length) throw new Error('Unequal reference lengths');
  let error = 0;
  for (let i = 0; i < actual.length; i++) error = Math.max(error, Math.abs(actual[i] - expected[i]));
  return error;
}
export function complexBin(samples, bin) {
  let real = 0, imaginary = 0;
  for (let n = 0; n < samples.length; n++) {
    real += samples[n] * Math.cos(2 * Math.PI * bin * n / samples.length);
    imaginary -= samples[n] * Math.sin(2 * Math.PI * bin * n / samples.length);
  }
  return { real: real * 2 / samples.length, imaginary: imaginary * 2 / samples.length,
    magnitude: Math.hypot(real, imaginary) * 2 / samples.length };
}
export const carrierBins = [208, 512, 1024, 1784, 1840];
export const multitone = n => carrierBins.reduce((sum, k) => sum + 0.15 * Math.cos(2 * Math.PI * k * n / 4096), 0);
