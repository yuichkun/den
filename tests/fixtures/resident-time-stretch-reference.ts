/** Independent scalar source-time oracle. No graph helpers or implementation
 * constants are imported. Arrays/loops belong only to offline verification. */
export interface StretchRow { gate: boolean; trigger: boolean; reset: boolean; durationScale: number; pitchRatio: number }
export interface StretchLoad { at: number; data: Float32Array }
export function stretchRows(frames: number, patch: (n: number) => Partial<StretchRow> = () => ({})): StretchRow[] {
  return Array.from({ length: frames }, (_, n) => ({ gate: true, trigger: false, reset: false, durationScale: 1, pitchRatio: 1, ...patch(n) }));
}
export function stretchPorts(rows: StretchRow[]) {
  return [Float32Array.from(rows, r => +r.gate), Float32Array.from(rows, r => +r.trigger), Float32Array.from(rows, r => +r.reset), Float32Array.from(rows, r => r.durationScale), Float32Array.from(rows, r => r.pitchRatio)];
}
export function stretchReference(rows: StretchRow[], loads: StretchLoad[], rate: number, sourceRate: number, hop = 256, radius = 64, capacity = 65536) {
  const output = Array.from({ length: 8 }, () => new Float32Array(rows.length));
  let pcm = new Float32Array(), active = false, pending = false, ended = false, rejected = false, previousGate = false;
  let age = 0, total = 0, length = 0, step = 1, current = 0, previous = 0, first = true, selected = 0;
  function at(index: number) { const v = pcm[index]; return index >= 0 && index < pcm.length && Number.isFinite(v) ? v : 0; }
  function read(position: number) { const left = Math.floor(position), f = position - left; return at(left) * (1 - f) + at(left + 1) * f; }
  for (let n = 0; n < rows.length; n++) {
    const c = rows[n], messages = loads.filter(load => load.at === n);
    for (const message of messages) pcm = message.data.slice(0, capacity);
    const missing = pcm.length === 0, clear = c.reset || messages.length > 0 || missing;
    if (clear || !c.gate) active = pending = false;
    if (clear) { ended = false; age = total = length = 0; }
    if (c.reset) rejected = false;
    if ((c.trigger || c.gate && !previousGate) && c.gate && !c.reset && !missing) pending = true;
    if (n % hop === 0) {
      const attempt = pending && c.gate && !c.reset;
      const duration = Math.fround(c.durationScale), pitch = Math.fround(c.pitchRatio);
      const valid = duration >= .5 && duration <= 2 && pitch >= .5 && pitch <= 2;
      const launch = attempt && valid && !missing;
      if (attempt) { pending = false; rejected = !valid; }
      if (launch) { age = 0; const numerator = BigInt(pcm.length) * BigInt(rate) * BigInt(duration * 2 ** 24), denominator = BigInt(sourceRate) * 16777216n; total = Number((numerator + denominator - 1n) / denominator); length = pcm.length; step = pitch * (sourceRate / rate); active = true; ended = false; }
      if (active) {
        const nominal = age * length / Math.max(total, 1), tail = current + step * hop;
        const reference = Array.from({ length: 64 }, (_, j) => read(tail + j * hop / 64 * step));
        const error = (offset: number) => reference.reduce((sum, v, j) => sum + (read(nominal + offset + j * hop / 64 * step) - v) ** 2, 0);
        let best = 0, bestError = error(0);
        for (let distance = 1; distance <= radius; distance++) for (const candidate of [distance, -distance]) {
          const cost = error(candidate); if (cost < bestError) { best = candidate; bestError = cost; }
        }
        previous = launch ? 0 : tail; current = launch ? 0 : nominal + best; selected = launch ? 0 : best; first = launch;
      }
    }
    if (active && age >= total) { active = false; ended = true; }
    const clock = n % hop, local = clock * step, blend = clock / hop;
    const value = first ? read(current + local) : (1 - blend) * read(previous + local) + blend * read(current + local);
    output[0][n] = active ? value : 0; output[1][n] = +active;
    output[2][n] = Math.min(age, total) * length / Math.max(total, 1);
    output[3][n] = +ended; output[4][n] = +pending; output[5][n] = +rejected; output[6][n] = +missing; output[7][n] = selected;
    if (active) age++;
    previousGate = c.gate && !c.reset;
  }
  return output;
}
export function stretchMaxError(a: ArrayLike<number>, b: ArrayLike<number>) { let e = 0; for (let i = 0; i < a.length; i++) e = Math.max(e, Math.abs(a[i] - b[i])); return e; }
export function stretchBin(signal: ArrayLike<number>, cycles: number) {
  let re = 0, im = 0; for (let n = 0; n < signal.length; n++) { re += signal[n] * Math.cos(2 * Math.PI * cycles * n); im -= signal[n] * Math.sin(2 * Math.PI * cycles * n); }
  return Math.hypot(re, im) * 2 / signal.length;
}
