// Independent numeric timeline. No production imports, DSL nodes or DSP helpers.
export type LoopRow = { gate: boolean; trigger: boolean; reset: boolean; rate: number };
export type LoopOptions = { start?: number; end?: number; crossfade: number; release?: number };
export type Replacement = { frame: number; pcm: Float32Array };
const bounded = (x: number, low: number, high: number) => Math.max(low, Math.min(high, Number.isNaN(x) ? 0 : x));
function modulo(value: number, period: number) {
  const remainder = value % period;
  return remainder < 0 ? remainder + period : remainder;
}
function interpolate(pcm: Float32Array, local: number, start: number, end: number, wrap: boolean) {
  const p = wrap ? modulo(local, end - start) : bounded(local, 0, end - start - 1);
  const whole = Math.floor(p), fraction = p - whole;
  const a = start + whole, b = a + 1 < end ? a + 1 : wrap ? start : end - 1;
  const x = Number.isFinite(pcm[a]) ? pcm[a] : 0, y = Number.isFinite(pcm[b]) ? pcm[b] : 0;
  return Math.fround((1 - fraction) * x + fraction * y);
}
export function loopWave(pcm: Float32Array, phase: number, start: number, end: number, overlap: number) {
  const period = end - start - overlap;
  if (period <= 0) return 0;
  const q = modulo(phase, period);
  const primary = interpolate(pcm, q, start + overlap, end, overlap === 0);
  if (overlap === 0 || q < period - overlap) return primary;
  const weight = (q - (period - overlap)) / overlap;
  const head = interpolate(pcm, q - (period - overlap), start, end, false);
  return Math.fround(primary * (1 - weight) + head * weight);
}
export function loopReference(initial: Float32Array, hostRate: number, sourceRate: number, rows: LoopRow[], options: LoopOptions, replacements: Replacement[] = []) {
  const { start = 0, end = initial.length, crossfade: requested, release = 0 } = options;
  let pcm = initial, phase = 0, active = false, previousGate = false, remaining = 0;
  const output: number[] = [], phases: number[] = [], positions: number[] = [], playing: number[] = [], missing: number[] = [], periods: number[] = [], overlaps: number[] = [];
  rows.forEach((c, frame) => {
    const replacement = replacements.find(x => x.frame === frame);
    if (replacement) { pcm = replacement.pcm; active = false; phase = 0; }
    const hi = Math.min(end, pcm.length), length = Math.max(0, hi - start);
    const overlap = Math.min(requested, Math.floor(length / 2)), period = length - overlap;
    const increment = bounded(Math.fround(c.rate), -16, 16) * sourceRate / hostRate;
    const trigger = (c.trigger || c.gate && !previousGate) && c.gate && !c.reset && length > 0;
    if (c.reset || !length) { active = false; phase = 0; }
    if (trigger) { phase = increment < 0 ? period - 1 : 0; active = true; remaining = release; }
    else if (!c.gate) remaining = Math.max(0, remaining - 1);
    const gain = release > 0 ? remaining / release : +c.gate;
    active = active && gain > 0;
    output.push(active ? Math.fround(loopWave(pcm, phase, start, hi, overlap) * gain) : 0);
    phases.push(Math.fround(phase)); positions.push(Math.fround(start + overlap + phase));
    playing.push(+active); missing.push(+(length === 0)); periods.push(period); overlaps.push(overlap);
    if (active) phase = modulo(phase + increment, period);
    if (!active) remaining = 0;
    previousGate = c.gate && !c.reset;
  });
  return [output, playing, positions, phases, periods, overlaps, missing];
}
