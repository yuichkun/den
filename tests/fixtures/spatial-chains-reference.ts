import { pitchReference } from './windowed-pitch-shift-reference.js';

/** Independent absolute-time model: direct FIR and expanded FDN equations.
 * No FFT, ring indices, DSL or production construction constants are imported.
 * f32 casts model the public readhead's interpolation operations, not ideal
 * integer delays at the rounded FDN reference lengths.
 */
export function spatialReference(data: readonly Float32Array[], sampleRate: number, width?: number) {
  const [input, mix, bypass, reset, ratio, pitchMix, retrigger] = data;
  const frames = input.length, color = new Float32Array(frames);
  const early = [new Float32Array(frames), new Float32Array(frames)];
  const late = [new Float32Array(frames), new Float32Array(frames)];
  const lineInput = Array.from({ length: 4 }, () => new Float32Array(frames));
  const lengths = [297, 371, 411, 437].map(n => Math.round(n * sampleRate / 10000));
  const delays = lengths.map(d => Math.min(d, sampleRate * Math.fround(d / sampleRate)));
  const gain = lengths.map(d => 10 ** (-3 * d / (sampleRate * .6)));
  const pole = Math.exp(-2 * Math.PI * Math.min(3500, .4 * sampleRate) / sampleRate);
  const damping = [0, 0, 0, 0];
  const excitation = Float32Array.from(input, (x, n) => bypass[n] > 0 || reset[n] > 0 ? 0 : x);
  let admittedSince = 0, retainedSince = 0;
  const read = (history: Float32Array, n: number, delay: number, start: number) => {
    const whole = Math.floor(delay), fraction = Math.fround(delay - whole);
    const at = (t: number) => t >= start && t < n ? history[t] : 0;
    return Math.fround(Math.fround(at(n - whole) * Math.fround(1 - fraction))
      + Math.fround(at(n - whole - 1) * fraction));
  };
  for (let n = 0; n < frames; n++) {
    if (reset[n] > 0) { admittedSince = n + 1; retainedSince = n; damping.fill(0); }
    const x = (t: number) => t >= admittedSince ? excitation[t] : 0;
    color[n] = reset[n] > 0 ? 0 : .625 * x(n - 8) + .25 * x(n - 11) - .125 * x(n - 15);
    const taps = [.007, .013, .023].map(t => read(color, n, Math.min(.023 * sampleRate, sampleRate * Math.fround(t)), retainedSince));
    early[0][n] = .5 * taps[0] + .25 * taps[1] - .125 * taps[2];
    early[1][n] = .25 * taps[0] - .25 * taps[1] + .375 * taps[2];
    const raw = delays.map((delay, ch) => read(lineInput[ch], n, delay, retainedSince));
    raw.forEach((v, ch) => { damping[ch] = pole * damping[ch] + (1 - pole) * v; });
    const [a, b, c, d] = damping.map((v, ch) => v * gain[ch]), inject = excitation[n] / 2;
    lineInput[0][n] = inject + (a + b + c + d) / 2;
    lineInput[1][n] = inject + (a - b + c - d) / 2;
    lineInput[2][n] = inject + (a + b - c - d) / 2;
    lineInput[3][n] = inject + (a - b - c + d) / 2;
    late[0][n] = (raw[0] + raw[1] - raw[2] - raw[3]) / 2;
    late[1][n] = (raw[0] - raw[1] - raw[2] + raw[3]) / 2;
  }
  const pitch = width === undefined ? undefined : late.map(channel => pitchReference([channel, ratio, reset, retrigger], width));
  const output = late.map((channel, ch) => Float32Array.from(channel, (f, n) => {
    if (reset[n] > 0) return 0;
    if (bypass[n] > 0) return input[n];
    const p = Math.min(1, Math.max(0, pitchMix[n])), m = Math.min(1, Math.max(0, mix[n]));
    const tail = pitch ? (1 - p) * f + p * pitch[ch][0][n] : f;
    return (1 - m) * input[n] + m * .5 * (early[ch][n] + tail);
  }));
  if (pitch) output.push(pitch[0][1]);
  return { output, early, late, pitched: pitch?.map(result => result[0]) };
}

/** input, mix, bypass, reset, ratio, pitchMix, retrigger. */
export const spatialPorts = (frames: number, changes: Record<number, number | ((n: number) => number)> = {}) =>
  Array.from({ length: 7 }, (_, ch) => Float32Array.from({ length: frames }, (_, n) => {
    const change = changes[ch];
    return typeof change === 'function' ? change(n) : change ?? (ch === 1 || ch === 4 ? 1 : ch === 5 ? .5 : 0);
  }));

export function maxError(actual: ArrayLike<number>, expected: ArrayLike<number>) {
  if (actual.length !== expected.length) return Infinity;
  let result = 0;
  for (let n = 0; n < actual.length; n++) result = Math.max(result, Math.abs(actual[n] - expected[n]));
  return result;
}
