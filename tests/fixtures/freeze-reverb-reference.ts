/** Independent absolute-time scalar model: no ring indices, DSL or DSP imports. */
export interface ReferenceConfig { sampleRate: number; roomScale?: number; decaySeconds?: number; transitionSamples?: number }
export function ports(frames: number, sources: Record<number, number | ((n: number) => number)> = {}) {
  return Array.from({ length: 4 }, (_, channel) => Float32Array.from({ length: frames }, (_, n) => {
    const source = sources[channel] ?? 0; return typeof source === 'function' ? source(n) : source;
  }));
}
export function freezeReference(data: Float32Array[], config: ReferenceConfig) {
  const lengths = [297, 371, 411, 437].map(x => Math.round(x / 10000 * (config.roomScale ?? 1) * config.sampleRate));
  const gains = lengths.map(d => 10 ** (-3 * d / (config.sampleRate * (config.decaySeconds ?? 1.5))));
  const count = config.transitionSamples ?? 256, steps = Math.max(1, count);
  const frames = data[0].length, histories = Array.from({ length: 4 }, () => new Float64Array(frames));
  const output = Array.from({ length: 4 }, () => new Float32Array(frames));
  let progress = 0, first = 0;
  for (let n = 0; n < frames; n++) {
    if (data[3][n] > 0) { first = n + 1; progress = 0; }
    else progress = count === 0 ? Number(data[2][n] > 0) : Math.max(0, Math.min(steps, progress + (data[2][n] > 0 ? 1 : -1)));
    const amount = progress / steps, excitation = 1 - amount;
    const tap = lengths.map((d, line) => n - d >= first ? histories[line][n - d] : 0);
    const x = tap.map((v, line) => v * (amount + excitation * gains[line]));
    const l = data[3][n] > 0 ? 0 : data[0][n] * excitation, r = data[3][n] > 0 ? 0 : data[1][n] * excitation;
    histories[0][n] = (l + r + x[0] + x[1] + x[2] + x[3]) / 2;
    histories[1][n] = (l - r + x[0] - x[1] + x[2] - x[3]) / 2;
    histories[2][n] = (l + r + x[0] + x[1] - x[2] - x[3]) / 2;
    histories[3][n] = (l - r + x[0] - x[1] - x[2] + x[3]) / 2;
    output[0][n] = (tap[0] + tap[1] - tap[2] - tap[3]) / 2;
    output[1][n] = (tap[0] - tap[1] - tap[2] + tap[3]) / 2;
    output[2][n] = amount; output[3][n] = Number(progress === steps);
  }
  return output;
}
export function maxError(a: Float32Array, b: Float32Array) {
  if (a.length !== b.length) throw new RangeError('different timeline lengths');
  let error = 0; for (let n = 0; n < a.length; n++) error = Math.max(error, Math.abs(a[n] - b[n])); return error;
}
export function energy(data: Float32Array[]) { return data.slice(0, 2).reduce((sum, channel) => channel.reduce((s, v) => s + v * v, sum), 0); }
