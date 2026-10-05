// Independent absolute-time input model. No ring buffer, native state, phase
// accumulator in cycles, or DSP helper is shared with the implementation.
export function pitchReference(ports: readonly Float32Array[], width: number) {
  const [input, controls, reset, retrigger] = ports;
  const output = new Float32Array(input.length), rejected = output.slice();
  let travel = 0, ratio = 1, firstRetained = 0;
  for (let n = 0; n < input.length; n++) {
    const valid = controls[n] >= 0.5 && controls[n] <= 2;
    rejected[n] = valid ? 0 : 1;
    if (valid) ratio = controls[n]; else if (reset[n] > 0) ratio = 1;
    if (reset[n] > 0 || retrigger[n] > 0) travel = 0;
    if (reset[n] > 0) firstRetained = n + 1;
    const position = ((travel % width) + width) % width;
    const phase = position / width, weight = 2 * Math.min(phase, 1 - phase);
    const sample = (i: number) => i >= firstRetained && i < n ? input[i] : 0;
    const interpolate = (time: number) => {
      const before = Math.floor(time), fraction = time - before;
      return (1 - fraction) * sample(before) + fraction * sample(before + 1);
    };
    output[n] = weight * interpolate(n - 1 - position)
      + (1 - weight) * interpolate(n - 1 - (position < width / 2 ? position + width / 2 : position - width / 2));
    if (reset[n] <= 0) travel += 1 - ratio;
  }
  return [output, rejected];
}
export const ports = (frames: number, changes: Record<number, number | ((n: number) => number)> = {}) =>
  Array.from({ length: 4 }, (_, channel) => Float32Array.from({ length: frames }, (_, n) => {
    const change = changes[channel];
    return typeof change === 'function' ? change(n) : change ?? (channel === 1 ? 1 : 0);
  }));
export function maxError(actual: Float32Array, expected: Float32Array) {
  if (actual.length !== expected.length) return Infinity;
  let error = 0;
  for (let n = 0; n < actual.length; n++) error = Math.max(error, Math.abs(actual[n] - expected[n]));
  return error;
}
export function complexBin(input: Float32Array, cyclesPerSample: number) {
  let real = 0, imaginary = 0;
  input.forEach((x, n) => { real += x * Math.cos(2 * Math.PI * cyclesPerSample * n); imaginary -= x * Math.sin(2 * Math.PI * cyclesPerSample * n); });
  real *= 2 / input.length; imaginary *= 2 / input.length;
  return { real, imaginary, magnitude: Math.hypot(real, imaginary) };
}
export function neighbor(value: number, direction: number) {
  const bits = new Uint32Array(1), values = new Float32Array(bits.buffer);
  values[0] = value; bits[0] += direction; return values[0];
}
