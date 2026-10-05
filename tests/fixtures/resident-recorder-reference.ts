// Plain scalar oracle. This file never imports den or unworklet.
export interface TakeRow { input: number; record: boolean; reset: boolean; position: number }
export interface TakeLoad { frame: number; data: Float32Array }
export function takeReference(capacity: number, rows: readonly TakeRow[], loads: readonly TakeLoad[] = [], loop = false) {
  const pcm = new Float32Array(capacity + 1);
  let length = 0, revision = 0;
  const output = Array.from({ length: 7 }, () => new Float32Array(rows.length));
  const read = (position: number) => {
    if (!length) return 0;
    let p = Number.isNaN(position) ? 0 : Math.max(-2147483648, Math.min(2147483647, position));
    p = loop ? p - Math.floor(p / length) * length : Math.max(0, Math.min(length - 1, p));
    const first = Math.max(0, Math.min(capacity - 1, Math.floor(p))), fraction = p - first;
    const second = first + 1 >= length ? (loop ? 0 : first) : first + 1;
    const a = Number.isFinite(pcm[first]) ? pcm[first] : 0, b = Number.isFinite(pcm[second]) ? pcm[second] : 0;
    return Math.fround(a + (b - a) * fraction);
  };
  rows.forEach((row, n) => {
    for (const load of loads.filter(x => x.frame === n)) { pcm.set(load.data.subarray(0, capacity + 1)); length = Math.min(capacity, load.data.length); revision = (revision + 1) | 0; }
    output[0][n] = read(row.position); output[1][n] = length;
    const written = row.record && !row.reset && length < capacity;
    if (written) { const value = Math.fround(row.input); pcm[length] = !Number.isFinite(value) || value === 0 ? 0 : value; }
    pcm[capacity] = 0;
    if (row.reset) { length = 0; revision = (revision + 1) | 0; } else if (written) length++;
    output[2][n] = read(row.position); output[3][n] = length; output[4][n] = +written; output[5][n] = +(length === capacity); output[6][n] = revision;
  });
  return { output, pcm, length, revision };
}
