// Independent direct complex DFT and absolute-time frame overlap. No native
// FFT, ring, framing cursor or shipping spectral texture helper is imported.
export const N = 64, H = 32, PERIOD = 544;
const window = Array.from({ length: N }, (_, n) => Math.sin(Math.PI * n / N));
const cos = Array.from({ length: N }, (_, k) => Array.from({ length: N }, (_, n) => Math.cos(2 * Math.PI * k * n / N)));
const sin = Array.from({ length: N }, (_, k) => Array.from({ length: N }, (_, n) => Math.sin(2 * Math.PI * k * n / N)));
const dft = (re, im, inverse = false) => {
  const result = [new Float64Array(N), new Float64Array(N)], direction = inverse ? 1 : -1;
  for (let k = 0; k < N; k++) for (let n = 0; n < N; n++) {
    result[0][k] += (re[n] * cos[k][n] - im[n] * direction * sin[k][n]) / (inverse ? N : 1);
    result[1][k] += (im[n] * cos[k][n] + re[n] * direction * sin[k][n]) / (inverse ? N : 1);
  }
  return result;
};
const defaults = { amount: 0, carrierLevel: 1, modulatorLevel: 1, reset: 0, flip: 0, samePattern: 0 };
export const parameterNames = Object.keys(defaults);
const valueAt = (params, name, n) => Math.fround(Array.isArray(params[name]) || ArrayBuffer.isView(params[name]) ? params[name][n] : params[name] ?? defaults[name]);
export function simulate(frames, params = {}, initialInverted = false, initialPreviousFlip = false) {
  const channels = Array.from({ length: 12 }, () => new Float64Array(frames + N));
  let inverted = initialInverted, previousFlip = initialPreviousFlip, lastReset = -1;
  for (let n = 0; n < frames; n++) {
    const values = parameterNames.map(name => valueAt(params, name, n));
    const [amount, carrierLevel, modulatorLevel, reset, flip, samePattern] = values;
    if (reset >= .5) { inverted = false; previousFlip = false; lastReset = n; channels[0].fill(0, n); channels[1].fill(0, n); }
    else { if (flip >= .5 && !previousFlip) inverted = !inverted; previousFlip = flip >= .5; }
    const a = ((n % 17) * 5 % 17 - 8) / 32, b = ((n % 17) * 7 % 17 - 8) / 32;
    channels[2][n] = Math.fround(Math.fround(a * carrierLevel) * (inverted ? -1 : 1));
    channels[3][n] = Math.fround((samePattern >= .5 ? a : b) * modulatorLevel);
    channels[4][n] = n % PERIOD; channels[5][n] = Number(inverted);
    values.forEach((value, j) => { channels[6 + j][n] = value; });
    if (n % H === 0) {
      const analyze = channel => dft(window.map((w, j) => n - N + j > lastReset ? channels[channel][n - N + j] * w : 0), new Float64Array(N));
      const carrier = analyze(2), modulator = analyze(3);
      const magnitudes = spectrum => spectrum[0].map((re, k) => Math.hypot(re, k === 0 || k === N / 2 ? 0 : spectrum[1][k]));
      const ca = magnitudes(carrier), ma = magnitudes(modulator), peak = Math.max(...ca);
      for (let mode = 0; mode < 2; mode++) {
        let transformed;
        if (amount === 0) transformed = carrier.map(plane => plane.slice());
        else {
          transformed = [new Float64Array(N), new Float64Array(N)];
          for (let k = 0; k <= N / 2; k++) {
            let target, phase;
            if (mode === 0) {
              // Two independent width-three box passes equal the radius-two
              // circular triangular kernel, including through DC/Nyquist.
              let sum = 0;
              for (let p = 0; p <= 2; p++) for (let q = 0; q <= 2; q++) sum += ca[(k + p - q + N) % N];
              target = (1 - amount) * ca[k] + amount * sum / 9;
              phase = ca[k] > 0 && ca[k] >= peak * 2 ** -20 ? Math.atan2(k === 0 || k === N / 2 ? 0 : carrier[1][k], carrier[0][k]) : 0;
            } else {
              target = (1 - amount) * ca[k] + amount * Math.min(ma[k], 4 * ca[k]);
              phase = ca[k] > 0 ? Math.atan2(k === 0 || k === N / 2 ? 0 : carrier[1][k], carrier[0][k]) : 0;
            }
            transformed[0][k] = target * Math.cos(phase);
            transformed[1][k] = k === 0 || k === N / 2 ? 0 : target * Math.sin(phase);
            if (k > 0 && k < N / 2) { transformed[0][N - k] = transformed[0][k]; transformed[1][N - k] = -transformed[1][k]; }
          }
        }
        const wave = dft(...transformed, true)[0];
        for (let j = 0; j < N; j++) channels[mode][n + j] += wave[j] * window[j] * 2 * H / N;
      }
    }
    if (reset >= .5) channels[0][n] = channels[1][n] = 0;
  }
  return channels.map(plane => Float32Array.from(plane.slice(0, frames)));
}
export function steadyPattern(params, inverted = false) {
  const wave = simulate(PERIOD * 4, params, inverted, (params.flip ?? 0) >= .5);
  return wave.map(channel => channel.slice(PERIOD * 3));
}
