// Independent direct real Fourier projection, not the production radix-2 FFT.
export function bandLimits(length: number) {
  const result: number[] = [];
  for (let h = length / 2 - 1; h; h = Math.floor(h / 2)) result.push(h);
  return result;
}
export function project(frames: readonly Float32Array[]) {
  const size = frames[0].length, limits = bandLimits(size), data = new Float32Array(size * frames.length * limits.length);
  frames.forEach((frame, index) => {
    const dc = frame.reduce((s, x) => s + x, 0) / size;
    const coefficients = Array.from({ length: size / 2 }, (_, k) => {
      let cosine = 0, sine = 0;
      frame.forEach((x, n) => { const a = 2 * Math.PI * k * n / size; cosine += x * Math.cos(a); sine += x * Math.sin(a); });
      return { cosine: 2 * cosine / size, sine: 2 * sine / size };
    });
    limits.forEach((limit, b) => {
      for (let n = 0; n < size; n++) {
        let value = dc;
        for (let k = 1; k <= limit; k++) { const a = 2 * Math.PI * k * n / size; value += coefficients[k].cosine * Math.cos(a) + coefficients[k].sine * Math.sin(a); }
        data[(b * frames.length + index) * size + n] = value;
      }
    });
  });
  return data;
}
const bound = (x: number, high: number) => Number.isNaN(x) ? 0 : Math.max(0, Math.min(high, x));
export function bandsReference(data: Float32Array, rate: number, size: number, count: number, controls: Float32Array[], initial = 0) {
  const limits = bandLimits(size); let phase = initial;
  function read(band: number, frame: number) {
    const p = phase * size, n = Math.floor(p), t = p - n, offset = (band * count + frame) * size;
    const a = data[offset + n], z = data[offset + (n + 1) % size];
    return Math.fround((Number.isFinite(a) ? a : 0) * (1 - t) + (Number.isFinite(z) ? z : 0) * t);
  }
  return Float32Array.from(controls[0], (_, n) => {
    if (controls[2][n]) phase = initial;
    const frequency = bound(controls[0][n], rate * .45), frame = bound(controls[1][n], count - 1), lo = Math.floor(frame), hi = Math.min(lo + 1, count - 1), fm = frame - lo;
    // Select one explicit transition/hold segment rather than summing ramps.
    let band = limits.length - 1, mix = 0;
    for (let b = 0; b < limits.length - 1; b++) {
      const end = .45 * rate / limits[b];
      if (frequency < end) { band = b; mix = Math.max(0, (frequency - end / 2) / (end / 2)); break; }
    }
    const next = Math.min(band + 1, limits.length - 1);
    const a = read(band, lo) * (1 - fm) + read(band, hi) * fm;
    const z = read(next, lo) * (1 - fm) + read(next, hi) * fm;
    const value = a * (1 - mix) + z * mix;
    phase += frequency / rate; phase -= Math.floor(phase);
    return value;
  });
}
export function coefficient(data: Float32Array, k: number) {
  let re = 0, im = 0;
  data.forEach((x, n) => { const a = 2 * Math.PI * k * n / data.length; re += x * Math.cos(a); im -= x * Math.sin(a); });
  return { re: re / data.length, im: im / data.length, magnitude: 2 * Math.hypot(re, im) / data.length };
}
