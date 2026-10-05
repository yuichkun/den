// Independent unbounded input timeline and absolute-sample fade schedule.
// This model never uses circular storage, DSP primitives, or the native countdown.
export interface ReferenceOptions { rate: number; capacity: number; transition: number }
export function dualHeadDelayReference(channels: readonly Float32Array[], options: ReferenceOptions) {
  const [audio, seconds, reset, feedback, mix] = channels;
  const { rate, capacity, transition } = options;
  let accepted = 1, settled = 1, historyStart = 0;
  let fade: { start: number; from: number; to: number } | undefined;
  const written: number[] = [];
  const wet = new Float32Array(audio.length), mixed = wet.slice(), rejected = wet.slice(), transitioning = wet.slice();
  const maximum = capacity / rate, minimum32 = Math.fround(1 / rate), maximum32 = Math.fround(maximum);
  for (let n = 0; n < audio.length; n++) {
    const fresh = n === 0 || reset[n] > 0;
    const valid = seconds[n] >= minimum32 && seconds[n] <= maximum32;
    rejected[n] = valid ? 0 : 1;
    if (fresh) { accepted = 1; settled = 1; historyStart = n; fade = undefined; }
    if (valid) accepted = Math.max(1, Math.min(capacity, seconds[n] * rate));
    if (fresh) settled = accepted;
    if (fade && n >= fade.start + transition) { settled = fade.to; fade = undefined; }
    if (!fade && accepted !== settled) fade = { start: n, from: settled, to: accepted };
    const at = (delay: number) => {
      const source = n - delay, before = Math.floor(source), fraction = source - before;
      const sample = (index: number) => index >= historyStart && index < n ? written[index] : 0;
      return sample(before) * (1 - fraction) + sample(before + 1) * fraction;
    };
    if (fade) {
      const alpha = (n - fade.start) / (transition - 1);
      wet[n] = at(fade.from) * (1 - alpha) + at(fade.to) * alpha;
      transitioning[n] = 1;
    } else wet[n] = at(settled);
    const amount = Math.max(0, Math.min(1, mix[n]));
    mixed[n] = audio[n] * (1 - amount) + wet[n] * amount;
    written.push(Math.fround(audio[n] + wet[n] * feedback[n]));
  }
  return [wet, rejected, transitioning, mixed];
}
export const channels = (n: number, rate: number, changes: Record<number, number | ((n: number) => number)> = {}) =>
  Array.from({ length: 6 }, (_, ch) => Float32Array.from({ length: n }, (_, i) => {
    const rule = changes[ch];
    if (typeof rule === 'function') return rule(i);
    return rule ?? (ch === 1 ? 4 / rate : ch === 4 ? 1 : 0);
  }));
export const maxError = (actual: Float32Array, expected: Float32Array) => {
  if (actual.length !== expected.length) return Infinity;
  let maximum = 0;
  for (let i = 0; i < actual.length; i++) maximum = Math.max(maximum, Math.abs(actual[i] - expected[i]));
  return maximum;
};
