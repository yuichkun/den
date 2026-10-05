import type { DriveCurve } from '../../src/drive.js';
import { curveValue } from './drive-reference.js';

// Independent direct-form oracle. Deliberately uses literal zero insertion and
// both complete high-rate convolutions, never DSP polyphase indexing or dry g.
export function referenceKernel(factor: 2 | 4) {
  const count = 32 * factor + 1, middle = (count - 1) / 2;
  const coefficient = Array.from({ length: count }, (_, k) => {
    if (k === 0 || k === count - 1) return 0;
    const u = (k - middle) * .9 / factor;
    const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    const window = .42 - .5 * Math.cos(2 * Math.PI * k / (count - 1)) + .08 * Math.cos(4 * Math.PI * k / (count - 1));
    return .9 / factor * sinc * window;
  });
  const dc = coefficient.reduce((a, b) => a + b);
  return coefficient.map(value => value / dc);
}
const bound = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isNaN(x) ? 0 : x));
export function oversampledReference(input: Float32Array[], factor: 2 | 4, curve: DriveCurve, decimationPhase = 0) {
  const [audio, gain, mix, reset] = input, h = referenceKernel(factor), count = audio.length * factor;
  const inserted = new Float64Array(count), dryInserted = new Float64Array(count);
  const shaped = new Float64Array(count), interpolatedDry = new Float64Array(count), output = new Float32Array(audio.length);
  let beginning = 0;
  const convolve = (signal: Float64Array, position: number) => {
    let sum = 0;
    for (let k = 0; k < h.length && position - k >= beginning; k++) sum += h[k] * signal[position - k];
    return sum;
  };
  for (let n = 0; n < audio.length; n++) {
    if (reset[n] > 0) beginning = n * factor;
    const dry = bound(audio[n], -8, 8), blend = bound(mix[n], 0, 1);
    inserted[n * factor] = dry * bound(gain[n], 0, 32); dryInserted[n * factor] = dry;
    for (let phase = 0; phase < factor; phase++) {
      const position = n * factor + phase;
      shaped[position] = curveValue(factor * convolve(inserted, position), curve);
      interpolatedDry[position] = factor * convolve(dryInserted, position);
    }
    const at = n * factor + decimationPhase;
    output[n] = (1 - blend) * convolve(interpolatedDry, at) + blend * convolve(shaped, at);
  }
  return output;
}
export function filterMagnitude(factor: 2 | 4, hostCycles: number) {
  const h = referenceKernel(factor);
  let re = 0, im = 0;
  h.forEach((v, i) => { re += v * Math.cos(2 * Math.PI * hostCycles * i / factor); im -= v * Math.sin(2 * Math.PI * hostCycles * i / factor); });
  return Math.hypot(re, im);
}
