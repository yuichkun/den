import { expect, test as baseTest } from 'vitest';
import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, inspect, select } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { curvedAdsr, musicalLfo, type CurvedAdsrConfig, type MusicalLfoConfig, type MusicalLfoWaveform } from '../src/musical-controls.js';
const test = (name: string, fn: () => unknown) => baseTest(name, fn, 30000);
const rates = [44100, 48000, 96000];
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const MIN = 2 ** -149, MAX_PHASE = 1 - 2 ** -24;
type EnvelopeRow = [number, number, number, number, number, number, number, number, number, number];
// gate, retrigger, reset, attack, decay, sustain, release, A/D/R bend.
function envelopeProcessor(config: CurvedAdsrConfig) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 10, name: 'controls' }), output = audioOutput({ channels: 4, name: 'main' });
    const env = instantiate(curvedAdsr, config, { name: 'envelope' });
    const other = instantiate(curvedAdsr, config, { name: 'independent' });
    return { process() { forSample(i => {
      const r = env.tick({ gate: input.ch(0).at(i).gt(0), retrigger: input.ch(1).at(i).gt(0), reset: input.ch(2).at(i).gt(0),
        attack: input.ch(3).at(i), decay: input.ch(4).at(i), sustain: input.ch(5).at(i), release: input.ch(6).at(i),
        attackBend: input.ch(7).at(i), decayBend: input.ch(8).at(i), releaseBend: input.ch(9).at(i) });
      const b = other.tick({ gate: bool(true), retrigger: bool(false), reset: bool(false),
        attack: f32(0), decay: f32(0), sustain: f32(.625), release: f32(0), attackBend: f32(0), decayBend: f32(0), releaseBend: f32(0) });
      [r.level, select(r.done, 1, 0), b.level, select(b.done, 1, 0)].forEach((x, ch) => output.ch(ch).at(i).write(x));
    }); } };
  });
}
function controls(rows: number[][]) { return rows[0].map((_, ch) => Float32Array.from(rows, r => r[ch])); }
function render(p: ReturnType<typeof defineProcessor>, sampleRate: number, rows: number[][], restore?: Uint8Array) {
  return renderOffline(p, { sampleRate, duration: (rows.length - .25) / sampleRate, inputs: { controls: controls(rows) }, restore });
}
// Event/absolute-time oracle. It schedules segments by their entry sample, not
// the DSP's integer elapsed-state recurrence. Curve uses Bernstein form.
function envelopeReference(rows: EnvelopeRow[], sampleRate: number) {
  type Kind = 'idle' | 'attack' | 'decay' | 'sustain' | 'release';
  let kind: Kind = 'idle', previousGate = false, last = 0;
  let segment = { first: 0, length: 0, start: 0, target: 0, bend: 0 };
  const frames = (s: number) => Math.floor(clamp(s, 0, 30) * sampleRate + .5);
  const curve = (t: number, b: number) => (1 + b) * t * (1 - t) + t * t;
  return rows.map((raw, n) => {
    const c = raw.map(Math.fround), [g, retrigger, reset, attack, decay, sustain, release, ab, db, rb] = c;
    const gate = g > 0, s = clamp(sustain, 0, 1);
    const enter = (next: Kind, start: number, target: number, length: number, bend: number, first = n) => {
      kind = next; segment = { first, start, target, length, bend: clamp(bend, -1, 1) };
    };
    if (reset > 0) { kind = 'idle'; last = 0; }
    else {
      if (!gate && previousGate && kind !== 'idle') enter('release', last, 0, frames(release), rb);
      else if (gate && (!previousGate || retrigger > 0)) enter('attack', last, 1, frames(attack), ab);
      if (kind === 'attack' && segment.length === 0) enter('decay', 1, s, frames(decay), db);
      if (kind === 'idle') last = 0;
      else if (kind === 'sustain') last = s;
      else {
        const k = n - segment.first + 1;
        const complete = k >= segment.length || kind === 'release' && segment.start === 0;
        last = Math.fround(complete ? segment.target : segment.start + (segment.target - segment.start) * curve(k / segment.length, segment.bend));
        if (complete) {
          if (kind === 'attack') enter('decay', 1, s, frames(decay), db, n + 1);
          else if (kind === 'decay') kind = 'sustain';
          else kind = 'idle';
        }
      }
    }
    previousGate = gate;
    return [Math.fround(last), Number(kind === 'idle')];
  });
}
function checkEnvelope(actual: Float32Array[], rows: EnvelopeRow[], sampleRate: number) {
  envelopeReference(rows, sampleRate).forEach((v, n) => {
    expect(Math.abs(actual[0][n] - v[0]), `envelope frame ${n}`).toBeLessThan(8e-8);
    expect(actual[1][n], `done frame ${n}`).toBe(v[1]);
    expect(actual[2][n]).toBe(.625); expect(actual[3][n]).toBe(0);
  });
}
for (const sampleRate of rates) {
  test(`curved ADSR exact endpoints and independently shaped segment targets at ${sampleRate}`, async () => {
    for (const bend of [-1, -.375, 0, .625, 1]) {
      const rows = Array.from({ length: 128 }, (_, n): EnvelopeRow => [Number(n < 48), 0, 0, 8 / sampleRate, 16 / sampleRate, .25, 16 / sampleRate, bend, -bend, bend]);
      const r = await render(envelopeProcessor({ sampleRate }), sampleRate, rows); checkEnvelope(r.outputs.main, rows, sampleRate);
      expect(r.outputs.main[0][7]).toBe(1); expect(r.outputs.main[0][23]).toBe(.25);
      expect(r.outputs.main[0][63]).toBe(0); expect(r.outputs.main[1][62]).toBe(0); expect(r.outputs.main[1][63]).toBe(1);
      // Absolute-level warping would change the .25 sustain endpoint for b!=0.
      if (bend !== 0) expect(Math.abs((.25 + bend * .25 * .75) - r.outputs.main[0][23])).toBeGreaterThan(.07);
      expect(r.diagnostics.scrubbedSamples).toBe(0);
    }
  });
  test(`curved ADSR interruption origins, latching, precedence and snapshot at ${sampleRate}`, async () => {
    const rows = Array.from({ length: 512 }, (_, n): EnvelopeRow => [Number(n < 8 || n >= 12 && n < 32 || n >= 36 && n < 64 || n >= 80 && n < 180),
      Number(n === 4 || n === 8 || n === 44 || n === 60 || n >= 132 && n < 137), Number(n === 40 || n >= 58 && n < 61 || n === 128),
      (n >= 52 && n < 64 ? 0 : n >= 128 ? 4 : 8) / sampleRate,
      (n >= 56 && n < 64 ? 0 : n >= 20 && n < 28 ? 100 : 8) / sampleRate,
      n >= 24 && n < 52 ? .5 : n >= 56 && n < 64 ? 2 : .25,
      (n >= 33 && n < 36 ? 0 : 16) / sampleRate,
      n < 12 ? -1 : 1, n >= 20 && n < 28 ? -1 : .75, n >= 33 && n < 36 ? 1 : -.5]);
    const p = envelopeProcessor({ sampleRate }), r = await render(p, sampleRate, rows);
    checkEnvelope(r.outputs.main, rows, sampleRate);
    const first = await render(p, sampleRate, rows.slice(0, 128)), last = await render(p, sampleRate, rows.slice(128), first.state);
    r.outputs.main.forEach((c, ch) => expect(last.outputs.main[ch]).toEqual(c.slice(128)));
    expect(r.diagnostics.scrubbedSamples).toBe(0);
  });
  test(`curved ADSR zero/rounded stages, held trigger, tiny release done and upper durations at ${sampleRate}`, async () => {
    const rows = Array.from({ length: 512 }, (_, n): EnvelopeRow => {
      if (n < 32) return [Number(n < 16), 0, 0, .1 / sampleRate, 0, MIN, 8 / sampleRate, -1, 1, 1];
      if (n < 64) return [Number(n > 32 && n < 48), 0, Number(n === 32), 0, 0, 0, 30, 0, 0, -1];
      if (n < 96) return [Number(n < 80), 0, 0, 3.25 / sampleRate, 2.75 / sampleRate, .375, .1 / sampleRate, 2, -2, 0];
      if (n < 128) return [1, 1, 0, -1, -1, n < 112 ? 2 : -1, -1, -3, 3, -3];
      return [1, 0, Number(n === 128), 60, 60, .5, 60, -1, 0, 0];
    });
    // Reset consumes the held gate; a retrigger starts the maximum attack.
    rows[129][1] = 1;
    const r = await render(envelopeProcessor({ sampleRate }), sampleRate, rows); checkEnvelope(r.outputs.main, rows, sampleRate);
    expect(r.outputs.main[0][0]).toBe(MIN);
    expect(r.outputs.main[0][18]).toBe(0); expect(r.outputs.main[1][18]).toBe(0);
    expect(r.outputs.main[1][22]).toBe(0); expect(r.outputs.main[1][23]).toBe(1);
    expect(r.outputs.main[1][47]).toBe(0); expect(r.outputs.main[1][48]).toBe(1);
    const slots = inspect(r.state).slots;
    expect(slots['envelope/total'].value).toBe(sampleRate * 30);
    expect(slots['envelope/elapsed'].value).toBe(383);
    for (const n of [129, 255, 511]) expect(r.outputs.main[0][n]).toBeCloseTo(((n - 128) / (sampleRate * 30)) ** 2, 12);
    expect(r.diagnostics.scrubbedSamples).toBe(0);
  });
}

const waves: MusicalLfoWaveform[] = ['sine', 'triangle', 'saw', 'square'];
// rate, reset, seek, position, phaseOffset, hold.
type LfoRow = [number, number, number, number, number, number];
function lfoProcessor(config: Omit<MusicalLfoConfig, 'waveform'>) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 6, name: 'controls' }), output = audioOutput({ channels: 8, name: 'main' });
    const units = waves.map((waveform, n) => instantiate(musicalLfo, { ...config, waveform }, { name: `lfo${n}` }));
    return { process() { forSample(i => {
      units.forEach((unit, n) => {
        const r = unit.tick({ rate: input.ch(0).at(i), reset: input.ch(1).at(i).gt(0), seek: input.ch(2).at(i).gt(0),
          position: input.ch(3).at(i), phaseOffset: input.ch(4).at(i), hold: input.ch(5).at(i).gt(0) });
        output.ch(n * 2).at(i).write(r.value); output.ch(n * 2 + 1).at(i).write(r.phase);
      });
    }); } };
  });
}
function waveAt(wave: MusicalLfoWaveform, phase: number) {
  if (wave === 'sine') return Math.sin(2 * Math.PI * phase);
  if (wave === 'triangle') return 2 / Math.PI * Math.asin(Math.sin(2 * Math.PI * phase));
  if (wave === 'saw') return 2 * phase - 1;
  return phase < .5 ? 1 : -1;
}
// Exact f32-unit integration is independent of the clock's scaled compensated
// f64 recurrence. Fixed binary divisions allow an integer numerator/denominator.
function unsignedUnits(value: number) {
  const a = new Float32Array([value]), bits = new Uint32Array(a.buffer)[0], exponent = bits >>> 23 & 255;
  return exponent === 0 ? BigInt(bits & 0x7fffff) : BigInt((bits & 0x7fffff) + 0x800000) << BigInt(exponent - 1);
}
function lfoReference(rows: LfoRow[], config: Omit<MusicalLfoConfig, 'waveform'>) {
  const scale = 1n << 149n, beats = config.mode === 'tempo' ? config.beatsPerCycle ?? 1 : 1;
  const multiplier = config.mode === 'tempo' ? 60 : 1;
  const numeratorBeats = beats >= 1 ? beats : 1, denominatorBeats = beats >= 1 ? 1 : 1 / beats;
  const denominator = BigInt(config.sampleRate * multiplier * numeratorBeats) * scale;
  let position = 0n, previousSeek = false;
  return rows.map(raw => {
    const [rate, reset, seek, request, offset, hold] = raw.map(Math.fround);
    if (reset > 0) position = 0n;
    else if (seek > 0 && !previousSeek) {
      const bounded = clamp(request, -1048576, 1048576);
      const rawUnits = unsignedUnits(Math.abs(bounded)) * (bounded < 0 ? -1n : 1n);
      const wrappedUnits = ((rawUnits % scale) + scale) % scale;
      let wrapped = Number(wrappedUnits) / Number(scale);
      // Independent bit-predecessor for the reviewed f64 upper-endpoint repair.
      if (wrapped === 1) { const x = new Float64Array([1]); new BigUint64Array(x.buffer)[0] -= 1n; wrapped = x[0]; }
      // All f64 wrapped fractions here are exact binary rationals representable
      // in units of 2^-149; convert via the integer f32 request or f64 mantissa.
      position = BigInt(wrapped * 2 ** 149) * BigInt(config.sampleRate * multiplier * numeratorBeats);
    }
    const base = Math.min(MAX_PHASE, Math.fround(Number(position) / Number(denominator)));
    const boundedOffset = clamp(offset, -1048576, 1048576), fraction = boundedOffset - Math.trunc(boundedOffset);
    const shifted = base + fraction, phase = Math.min(MAX_PHASE, Math.fround(shifted - Math.floor(shifted)));
    if (!(reset > 0 || hold > 0)) position = (position + unsignedUnits(clamp(rate, 0, config.mode === 'free' ? 20 : 1000)) * BigInt(denominatorBeats)) % denominator;
    previousSeek = seek > 0;
    return phase;
  });
}
function checkLfo(actual: Float32Array[], rows: LfoRow[], config: Omit<MusicalLfoConfig, 'waveform'>) {
  const expected = lfoReference(rows, config);
  expected.forEach((phase, i) => waves.forEach((wave, n) => {
    expect(actual[n * 2 + 1][i], `${wave} phase frame ${i}`).toBe(phase);
    expect(Math.abs(actual[n * 2][i] - waveAt(wave, phase)), `${wave} frame ${i}`).toBeLessThan(8e-8);
  }));
}
for (const sampleRate of rates) {
  for (const mode of ['free', 'tempo'] as const) test(`musical LFO ${mode} waves, tempo changes, control precedence and snapshot at ${sampleRate}`, async () => {
    const config = { sampleRate, mode, beatsPerCycle: mode === 'tempo' ? 1 / 64 : 1 };
    const rows = Array.from({ length: 2048 }, (_, n): LfoRow => [n < 512 ? 137 : n < 768 ? 0 : n < 1024 ? -1 : n < 1536 ? 1000 + n % 97 : 9.25,
      Number(n >= 127 && n < 131 || n >= 511 && n < 515 || n >= 1023 && n < 1027),
      Number(n >= 128 && n < 134 || n === 255 || n >= 512 && n < 519 || n === 1023 || n === 1280 || n === 1536),
      n < 255 ? .75 : n < 512 ? -.25 : n < 1280 ? 1.125 : n < 1536 ? -(2 ** -60) : 1048576,
      n < 384 ? 0 : n < 768 ? -.25 : n < 1280 ? .125 : n < 1664 ? -(2 ** -60) : 1048576,
      Number(n >= 1200 && n < 1400)]);
    const p = lfoProcessor(config), result = await render(p, sampleRate, rows); checkLfo(result.outputs.main, rows, config);
    const first = await render(p, sampleRate, rows.slice(0, 1024)), last = await render(p, sampleRate, rows.slice(1024), first.state);
    result.outputs.main.forEach((c, ch) => expect(last.outputs.main[ch]).toEqual(c.slice(1024)));
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  });
}

test('musical LFO tempo divisions preserve BPM ratios at slow, ordinary and fastest cycle lengths', async () => {
  const sampleRate = 48000;
  for (const beatsPerCycle of [1 / 64, 1 / 8, 1, 2, 64]) {
    const config = { sampleRate, mode: 'tempo' as const, beatsPerCycle };
    const rows = Array.from({ length: 1024 }, (_, n): LfoRow => [n < 512 ? 137 : 231.5, 0, 0, 0, 0, 0]);
    const result = await render(lfoProcessor(config), sampleRate, rows);
    checkLfo(result.outputs.main, rows, config);
    expect(result.outputs.main[1][511]).toBe(Math.fround(511 * 137 / (sampleRate * 60 * beatsPerCycle) % 1));
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
});

test('musical LFO signed offsets, reset/seek endpoints and deliberately quantized square edges', async () => {
  const sampleRate = 48000, config = { sampleRate, mode: 'free' as const };
  const phases = [0, MIN, -(2 ** -149), -(2 ** -60), .25, .5, .75, 1 - 2 ** -24, 1, -1, -1 + 2 ** -24, -1 - 2 ** -23];
  const rows = Array.from({ length: 512 }, (_, n): LfoRow => [0, Number(n < 256), Number(n >= 256 && n % 2 === 0),
    phases[Math.floor(n / 2) % phases.length], phases[Math.floor(n / 2) % phases.length], 1]);
  rows.forEach((r, n) => { if (n >= 256) r[4] = n >= 384 ? 1048576 : 0; });
  const r = await render(lfoProcessor(config), sampleRate, rows); checkLfo(r.outputs.main, rows, config);
  expect(r.outputs.main[1][4]).toBe(MAX_PHASE); // Negative subnormal offset at base zero.
  expect(r.outputs.main[1][386]).toBeGreaterThanOrEqual(0);
  const edge = Array.from({ length: 128 }, (_, n): LfoRow => [2 ** -10, 0, Number(n === 0), .5 - 2 ** -25, 0, 0]);
  const q = await render(lfoProcessor(config), sampleRate, edge); checkLfo(q.outputs.main, edge, config);
  expect(q.outputs.main[6][0]).toBe(1); expect(q.outputs.main[6][1]).toBe(-1);
  expect(.5 - 2 ** -25 + 2 ** -10 / sampleRate).toBeLessThan(.5); // Public f32 rounding intentionally advances this edge.
});

test('musical LFO smallest positive rate accumulates through state and survives snapshot', async () => {
  const sampleRate = 48000, config = { sampleRate, mode: 'free' as const }, frames = 49152;
  const rows = Array.from({ length: frames }, (): LfoRow => [MIN, 0, 0, 0, 1048576, 0]);
  const p = lfoProcessor(config), whole = await render(p, sampleRate, rows);
  // No integer offset may erase the tiny public base phase. Minimum rate can
  // round away in output for many samples without being flushed from state.
  expect(whole.outputs.main[1][24000]).toBe(0);
  expect(whole.outputs.main[1][24001]).toBe(MIN);
  expect(whole.outputs.main[0][24001]).toBe(6 * MIN);
  expect(whole.outputs.main[1][48000]).toBe(MIN);
  const first = await render(p, sampleRate, rows.slice(0, 24576)), last = await render(p, sampleRate, rows.slice(24576), first.state);
  whole.outputs.main.forEach((c, ch) => expect(last.outputs.main[ch]).toEqual(c.slice(24576)));
  expect(whole.diagnostics.scrubbedSamples).toBe(0);
});

test('musical controls reject unsupported construction settings', () => {
  for (const sampleRate of [8000, 192000]) {
    expect(() => envelopeProcessor({ sampleRate })).not.toThrow();
    expect(() => lfoProcessor({ sampleRate, mode: 'tempo', beatsPerCycle: 64 })).not.toThrow();
  }
  for (const sampleRate of [0, 7999, 192001, 48000.5, NaN, Infinity]) {
    expect(() => envelopeProcessor({ sampleRate })).toThrow(RangeError);
    expect(() => lfoProcessor({ sampleRate, mode: 'free' })).toThrow(RangeError);
  }
  for (const beatsPerCycle of [0, 1 / 128, 128, 3, NaN, Infinity]) {
    expect(() => lfoProcessor({ sampleRate: 48000, mode: 'tempo', beatsPerCycle })).toThrow(RangeError);
  }
  expect(() => lfoProcessor({ sampleRate: 48000, mode: 'free', beatsPerCycle: 2 })).toThrow(RangeError);
  expect(() => lfoProcessor({ sampleRate: 48000, mode: 'other' as 'free' })).toThrow(RangeError);
  const badWave = () => defineProcessor(() => {
    instantiate(musicalLfo, { sampleRate: 48000, mode: 'free', waveform: 'random' as MusicalLfoWaveform }, { name: 'bad' });
    return { process() {} };
  });
  expect(badWave).toThrow(RangeError);
});
