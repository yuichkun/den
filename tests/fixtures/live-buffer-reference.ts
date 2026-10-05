// Independent chronological oracle: no den/unworklet imports, circular buffer,
// native state encoding, modulo addressing or production interpolation helpers.
export interface LiveRow { input: number; record: boolean; reset: boolean; age: number }
export function liveReference(capacity: number, rows: readonly LiveRow[]) {
  let history: number[] = [], revision = 0;
  const output = Array.from({ length: 9 }, () => new Float32Array(rows.length));
  const read = (age: number) => {
    const length = Math.min(capacity, history.length);
    const available = Number.isFinite(age) && age >= 0 && age <= length - 1;
    if (!available) return { output: 0, available: false };
    const whole = Math.floor(age), fraction = age - whole;
    const a = history[history.length - 1 - whole];
    const b = history[history.length - 1 - Math.min(whole + 1, length - 1)];
    return { output: Math.fround(a + (b - a) * fraction), available: true };
  };
  rows.forEach((row, n) => {
    const before = read(row.age);
    output[0][n] = before.output; output[1][n] = +before.available; output[2][n] = Math.min(capacity, history.length);
    const written = row.record && !row.reset;
    if (row.reset) history = [];
    else if (written) {
      const value = Math.fround(row.input);
      history.push(Number.isFinite(value) && value !== 0 ? value : 0);
    }
    if (written || row.reset) revision = (revision + 1) | 0;
    const after = read(row.age), length = Math.min(capacity, history.length);
    output[3][n] = after.output; output[4][n] = +after.available; output[5][n] = length;
    output[6][n] = +written; output[7][n] = +(length === capacity); output[8][n] = revision;
  });
  return { output, history, revision };
}
