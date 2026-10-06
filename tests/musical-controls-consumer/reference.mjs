// Independent event-time ADSR and exact integer-f32-unit clock references.
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const minimum = 2 ** -149, phaseMaximum = 1 - 2 ** -24;
export const channels = rows => rows[0].map((_, ch) => Float32Array.from(rows, r => r[ch]));
export function envelopeRows(rate, length = 1024) {
  return Array.from({ length }, (_, n) => {
    const k = n % 512;
    if (k < 32) return [Number(k < 16), 0, 0, 0, 0, minimum, 8 / rate, -1, 1, 1];
    return [Number(k >= 36 && k < 48 || k >= 52 && k < 176 || k >= 320 && k < 416 || k >= 440 && k < 480),
      Number(k === 40 || k === 48 || k === 92 || k === 380), Number(k >= 360 && k < 364),
      (k >= 440 ? 0 : 80) / rate, (k >= 440 ? 0 : k >= 172 && k < 190 ? 40 : 96) / rate,
      k >= 64 && k < 88 ? .625 : k >= 440 ? 0 : .25, (k >= 441 ? 30 * rate : 128) / rate,
      k < 100 ? -1 : .5, k >= 172 && k < 190 ? -1 : 1, k >= 177 && k < 190 ? -1 : .75];
  });
}
export function envelopeReference(rows, sampleRate) {
  let kind = 'idle', previousGate = false, last = 0;
  let segment = { first: 0, length: 0, start: 0, target: 0, bend: 0 };
  const frames = s => Math.floor(clamp(s, 0, 30) * sampleRate + .5);
  return rows.map((raw, n) => {
    const [g, retrigger, reset, attack, decay, sustain, release, ab, db, rb] = raw.map(Math.fround), gate = g > 0, s = clamp(sustain, 0, 1);
    const enter = (next, start, target, length, bend, first = n) => { kind = next; segment = { first, start, target, length, bend: clamp(bend, -1, 1) }; };
    if (reset > 0) { kind = 'idle'; last = 0; }
    else {
      if (!gate && previousGate && kind !== 'idle') enter('release', last, 0, frames(release), rb);
      else if (gate && (!previousGate || retrigger > 0)) enter('attack', last, 1, frames(attack), ab);
      if (kind === 'attack' && segment.length === 0) enter('decay', 1, s, frames(decay), db);
      if (kind === 'idle') last = 0;
      else if (kind === 'sustain') last = s;
      else {
        const k = n - segment.first + 1, t = k / Math.max(1, segment.length);
        const complete = k >= segment.length || kind === 'release' && segment.start === 0;
        const weight = (1 + segment.bend) * t * (1 - t) + t * t;
        last = Math.fround(complete ? segment.target : segment.start + (segment.target - segment.start) * weight);
        if (complete) {
          if (kind === 'attack') enter('decay', 1, s, frames(decay), db, n + 1);
          else kind = kind === 'decay' ? 'sustain' : 'idle';
        }
      }
    }
    previousGate = gate;
    return [Math.fround(last), Number(kind === 'idle')];
  });
}
export function lfoRows(length = 2048) {
  return Array.from({ length }, (_, n) => [n < 512 ? 137 : n < 768 ? 0 : n < 1024 ? -1 : n < 1536 ? 1100 : 9.25,
    Number(n >= 127 && n < 131 || n >= 511 && n < 515 || n >= 1023 && n < 1027),
    Number(n >= 128 && n < 134 || n === 255 || n >= 512 && n < 519 || n === 1023 || n === 1280 || n === 1536 || n === 1792),
    n < 255 ? .75 : n < 512 ? -.25 : n < 1280 ? 1.125 : n < 1536 ? -(2 ** -60) : n < 1792 ? 1048576 : minimum,
    n < 384 ? 0 : n < 768 ? -.25 : n < 1280 ? .125 : n < 1664 ? -(2 ** -60) : 1048576,
    Number(n >= 1200 && n < 1400 || n >= 1792)]);
}
function unsignedUnits(value) {
  const a = new Float32Array([value]), bits = new Uint32Array(a.buffer)[0], exponent = bits >>> 23 & 255;
  return exponent === 0 ? BigInt(bits & 0x7fffff) : BigInt((bits & 0x7fffff) + 0x800000) << BigInt(exponent - 1);
}
export function lfoReference(rows, sampleRate, mode, beatsPerCycle = 1) {
  const scale = 1n << 149n, beats = mode === 'tempo' ? beatsPerCycle : 1, multiplier = mode === 'tempo' ? 60 : 1;
  const numerator = beats >= 1 ? beats : 1, rateMultiplier = beats >= 1 ? 1 : 1 / beats;
  const threshold = BigInt(sampleRate * multiplier * numerator), denominator = threshold * scale;
  let position = 0n, previousSeek = false;
  return rows.map(raw => {
    const [rate, reset, seek, request, offset, hold] = raw.map(Math.fround);
    if (reset > 0) position = 0n;
    else if (seek > 0 && !previousSeek) {
      const bounded = clamp(request, -1048576, 1048576), input = unsignedUnits(Math.abs(bounded)) * (bounded < 0 ? -1n : 1n);
      let wrapped = Number(((input % scale) + scale) % scale) / Number(scale);
      if (wrapped === 1) { const bits = new Float64Array([1]); new BigUint64Array(bits.buffer)[0] -= 1n; wrapped = bits[0]; }
      position = BigInt(wrapped * 2 ** 149) * threshold;
    }
    const base = Math.min(phaseMaximum, Math.fround(Number(position) / Number(denominator)));
    const limited = clamp(offset, -1048576, 1048576), shifted = base + (limited - Math.trunc(limited));
    const phase = Math.min(phaseMaximum, Math.fround(shifted - Math.floor(shifted)));
    if (!(reset > 0 || hold > 0)) position = (position + unsignedUnits(clamp(rate, 0, mode === 'free' ? 20 : 1000)) * BigInt(rateMultiplier)) % denominator;
    previousSeek = seek > 0;
    return phase;
  });
}
export function waveReference(wave, phase) {
  if (wave === 'sine') return Math.sin(2 * Math.PI * phase);
  if (wave === 'triangle') return 2 / Math.PI * Math.asin(Math.sin(2 * Math.PI * phase));
  if (wave === 'saw') return 2 * phase - 1;
  return phase < .5 ? 1 : -1;
}
