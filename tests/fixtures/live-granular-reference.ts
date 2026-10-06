/** Independent chronological store and absolute rational source identities.
 * This deliberately has no ring address or accepted-write age recurrence. */
export interface LiveGrainRow { input: number; record: boolean; reset: boolean; trigger: boolean; age: number; rate: number; seconds: number }
export function liveGrainRows(frames: number, change: (n: number) => Partial<LiveGrainRow> = () => ({})): LiveGrainRow[] {
  return Array.from({ length: frames }, (_, n) => {
    const r = { input: .5, record: true, reset: false, trigger: false, age: 0, rate: 1, seconds: .01, ...change(n) };
    return { ...r, input: Math.fround(r.input), age: Math.fround(r.age), rate: Math.fround(r.rate), seconds: Math.fround(r.seconds) };
  });
}
export const liveGrainPorts = (rows: readonly LiveGrainRow[]) => [
  Float32Array.from(rows, r => r.input), Float32Array.from(rows, r => +r.record),
  Float32Array.from(rows, r => +r.reset), Float32Array.from(rows, r => +r.trigger),
  Float32Array.from(rows, r => r.age), Float32Array.from(rows, r => r.rate), Float32Array.from(rows, r => r.seconds),
];
const UNIT = 2 ** 149, U = BigInt(UNIT);
const exact = (f32: number) => BigInt(Math.fround(f32) * UNIT);
interface Grain { position: bigint; step: bigint; index: number; duration: number }
export function liveGrainReference(capacity: number, maxGrains: number, sampleRate: number, rows: readonly LiveGrainRow[]) {
  let history: number[] = [], serial = -1;
  const grains: (Grain | undefined)[] = new Array(maxGrains);
  const output = Array.from({ length: 8 }, () => new Float32Array(rows.length));
  rows.forEach((raw, n) => {
    const r = { ...raw, input: Math.fround(raw.input), age: Math.fround(raw.age), rate: Math.fround(raw.rate), seconds: Math.fround(raw.seconds) };
    const written = r.record && !r.reset;
    if (r.reset) { history = []; serial = -1; grains.fill(undefined); }
    else if (written) { history.push(Number.isFinite(r.input) && r.input !== 0 ? r.input : 0); if (history.length > capacity) history.shift(); serial++; }
    const ageAt = (g: Grain) => Number(BigInt(serial) * U - g.position) / UNIT;
    let expired = 0;
    grains.forEach((g, j) => {
      if (!g) return;
      const age = ageAt(g);
      if (age < 0 || age > history.length - 1) { grains[j] = undefined; expired++; }
    });
    const request = r.trigger && !r.reset;
    const valid = Number.isFinite(r.age) && r.age >= 0 && r.age <= capacity - 1 && r.age <= history.length - 1
      && Number.isFinite(r.rate) && r.rate >= -16 && r.rate <= 16 && Number.isFinite(r.seconds) && r.seconds >= 0 && r.seconds <= 2;
    let launched = false, dropped = false;
    if (request && valid) {
      const free = grains.findIndex(g => !g);
      if (free < 0) dropped = true;
      else { grains[free] = { position: BigInt(serial) * U - exact(r.age), step: exact(r.rate), index: 0, duration: Math.max(3, Math.min(Math.round(2 * sampleRate), Math.floor(r.seconds * sampleRate + .5))) }; launched = true; }
    }
    let sum = 0, count = 0;
    grains.forEach((g, j) => {
      if (!g) return;
      const age = ageAt(g), whole = Math.floor(age), fraction = age - whole;
      const a = history[history.length - 1 - whole], b = history[Math.max(0, history.length - 2 - whole)];
      const pcm = Math.fround(a + (b - a) * fraction);
      const window = Math.max(0, 1 - Math.abs(2 * g.index / (g.duration - 1) - 1));
      sum += pcm * window; count++;
      g.position += g.step;
      if (++g.index >= g.duration) grains[j] = undefined;
    });
    [Math.fround(sum / maxGrains), count, +launched, +dropped, +(request && !valid), expired, +written, history.length].forEach((v, ch) => { output[ch][n] = v; });
  });
  return output;
}
export function liveGrainError(actual: Float32Array, expected: Float32Array) {
  let error = 0;
  for (let i = 0; i < actual.length; i++) error = Math.max(error, Math.abs(actual[i] - expected[i]));
  return error;
}
