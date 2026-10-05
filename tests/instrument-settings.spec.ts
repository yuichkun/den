import { expect, test } from 'vitest';
import { defineSubgraph, f32, type MidiEvent, type Node } from '@unworklet/core';
import { renderOffline, type RenderOfflineConfig } from '@unworklet/offline';
import { createInstrument, type InstrumentConfig } from '../src/instrument.js';
import {
  bassConfig, bassParameters, percussionConfig, percussionParameters, padConfig, padParameters,
} from '../src/instrument-settings.js';
import type { OscillatorConfig } from '../src/oscillator.js';
import type { FilterConfig } from '../src/filter.js';

// Independent, literal proposals. Neither implementation defaults nor rendered
// PCM supply expected settings, envelope values, frequencies, or cutoffs.
const expectedBass = {
  gain: 0.12,
  ampAttack: 0.005, ampDecay: 0.12, ampSustain: 0.7, ampRelease: 0.12,
  pitchAttack: 0, pitchDecay: 0, pitchSustain: 0, pitchRelease: 0,
  filterAttack: 0.003, filterDecay: 0.18, filterSustain: 0.2, filterRelease: 0.12,
  cutoff: 300, resonance: 0.707, pitchEnvelopeDepth: 0, filterEnvelopeDepth: 3,
  lfoRate: 0, lfoAmpDepth: 0, lfoPitchDepth: 0, lfoFilterDepth: 0, bypass: 0,
};
const expectedPercussion = {
  gain: 0.16,
  ampAttack: 0.001, ampDecay: 0.22, ampSustain: 0, ampRelease: 0.04,
  pitchAttack: 0, pitchDecay: 0.06, pitchSustain: 0, pitchRelease: 0.04,
  filterAttack: 0, filterDecay: 0.08, filterSustain: 0, filterRelease: 0.04,
  cutoff: 800, resonance: 0.5, pitchEnvelopeDepth: 24, filterEnvelopeDepth: 2,
  lfoRate: 0, lfoAmpDepth: 0, lfoPitchDepth: 0, lfoFilterDepth: 0, bypass: 0,
};
const expectedPad = {
  gain: 0.045,
  ampAttack: 0.8, ampDecay: 1.2, ampSustain: 0.7, ampRelease: 2.4,
  pitchAttack: 0, pitchDecay: 0, pitchSustain: 0, pitchRelease: 0,
  filterAttack: 1.4, filterDecay: 1.6, filterSustain: 0.5, filterRelease: 2.4,
  cutoff: 1400, resonance: 0.5, pitchEnvelopeDepth: 0, filterEnvelopeDepth: 0.75,
  lfoRate: 0.12, lfoAmpDepth: 0.08, lfoPitchDepth: 0.03, lfoFilterDepth: 0.2, bypass: 0,
};
type Parameters = typeof expectedBass;
type EnvelopeName = 'amp' | 'pitch' | 'filter';
type Probe = 'dc' | 'frequency' | 'cutoff';
const candidates = [
  { name: 'Bass', config: bassConfig, parameters: bassParameters, expected: expectedBass,
    construction: { mode: 'mono', capacity: 1, heldCapacity: 32, legato: true, waveform: 'saw' } },
  { name: 'Percussion', config: percussionConfig, parameters: percussionParameters, expected: expectedPercussion,
    construction: { mode: 'mono', capacity: 1, heldCapacity: 32, legato: false, waveform: 'sine' } },
  { name: 'Pad', config: padConfig, parameters: padParameters, expected: expectedPad,
    construction: { mode: 'poly', capacity: 4, heldCapacity: 32, waveform: 'saw' } },
];
const rates = [44100, 48000, 96000];
const dc = defineSubgraph((_config: OscillatorConfig) => ({
  tick: (_frequency: Node<'f32'>, _reset: Node<'bool'>) => f32(1),
}));
const frequency = defineSubgraph((_config: OscillatorConfig) => ({
  tick: (hz: Node<'f32'>, _reset: Node<'bool'>) => hz.div(1000),
}));
const wire = defineSubgraph((_config: FilterConfig) => ({
  tick: (input: Node<'f32'>, _cutoff: Node<'f32'>, _q: Node<'f32'>, _reset: Node<'bool'>) => input,
}));
const cutoff = defineSubgraph((_config: FilterConfig) => ({
  tick: (_input: Node<'f32'>, hz: Node<'f32'>, _q: Node<'f32'>, _reset: Node<'bool'>) => hz.div(20000),
}));
const probeConfig = (config: InstrumentConfig, probe: Probe): InstrumentConfig => ({
  ...config, oscillator: probe === 'frequency' ? frequency : dc, filter: probe === 'cutoff' ? cutoff : wire,
});
const on = (note: number, velocity = 127): MidiEvent => ({ type: 'noteOn', note, velocity, channel: 0 });
const off = (note: number): MidiEvent => ({ type: 'noteOff', note, velocity: 0, channel: 0 });
const cc = (controller: number): MidiEvent => ({ type: 'cc', controller, value: 0, channel: 0 });
const at = (atSample: number, payload: MidiEvent) => ({ name: 'midi', atSample, payload });
const quantum = (seconds: number, rate: number) => Math.round(seconds * rate / 128) * 128;
const frames = (seconds: number, rate: number) => Math.round(Math.fround(seconds) * rate);
const endFrame = (n: number) => Math.ceil(n / 128) * 128;
const nativeParams = (p: Parameters) => Object.fromEntries(Object.entries(p).map(([key, value]) => [key, [value]]));

// Closed-form lines, not a copy of the engine's sample-by-sample state machine.
// Segment counts use the documented f32 seconds -> nearest integer frame rule.
function held(age: number, attack: number, decay: number, sustain: number, start = 0) {
  if (age < 0) return 0;
  if (age < attack) return start + (1 - start) * (age + 1) / attack;
  const decayAge = age - attack;
  return decayAge < decay ? 1 + (sustain - 1) * (decayAge + 1) / decay : sustain;
}
function released(age: number, duration: number, start: number) {
  return duration === 0 ? 0 : start * Math.max(0, 1 - (age + 1) / duration);
}
function envelope(p: Parameters, target: EnvelopeName, rate: number, n: number, begin: number, end = Infinity, start = 0) {
  const a = frames(p[`${target}Attack`], rate), d = frames(p[`${target}Decay`], rate);
  const s = Math.fround(p[`${target}Sustain`]);
  if (n < end) return held(n - begin, a, d, s, start);
  return released(n - end, frames(p[`${target}Release`], rate), held(end - begin - 1, a, d, s, start));
}
const wave = (p: Parameters, rate: number, n: number) => Math.sin(2 * Math.PI * Math.fround(p.lfoRate) * n / rate);
const tremolo = (p: Parameters, rate: number, n: number) => 1 - Math.fround(p.lfoAmpDepth) * (1 - wave(p, rate, n)) / 2;
function pitchHz(p: Parameters, rate: number, n: number, note: number, level: number) {
  const semitones = Math.max(-24, Math.min(24, level * p.pitchEnvelopeDepth + wave(p, rate, n) * p.lfoPitchDepth));
  return Math.min(0.45 * rate, 440 * 2 ** ((note - 69) / 12) * 2 ** (semitones / 12));
}
function cutoffHz(p: Parameters, rate: number, n: number, level: number) {
  const octaves = Math.max(-8, Math.min(8, level * p.filterEnvelopeDepth + wave(p, rate, n) * p.lfoFilterDepth));
  return Math.max(20, Math.min(20000, 0.45 * rate, p.cutoff * 2 ** octaves));
}
function close(actual: ArrayLike<number>, expected: (n: number) => number) {
  let maxError = 0, worstSample = 0;
  for (let n = 0; n < actual.length; n++) {
    const error = Math.abs(actual[n] - expected(n));
    if (error > maxError) { maxError = error; worstSample = n; }
  }
  // Existing independent control-probe budget, fixed before rendering. These
  // probes avoid an invalid dynamic direct-form-biquad vs SVF comparison.
  expect(maxError, `maximum absolute error at sample ${worstSample}`).toBeLessThan(2e-6);
}
async function render(config: InstrumentConfig, p: Parameters, rate: number, length: number,
  events: NonNullable<RenderOfflineConfig['events']>, options: Partial<RenderOfflineConfig> = {}) {
  const result = await renderOffline(createInstrument(config), {
    sampleRate: rate, duration: (length - 0.5) / rate, events, ...options,
    params: { ...nativeParams(p), ...options.params },
  });
  expect(result.outputs.main[0].length).toBe(length);
  expect(result.outputs.main[0].every(Number.isFinite)).toBe(true);
  expect(result.outputs.main[0]).toEqual(result.outputs.main[1]);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  return result;
}

for (const candidate of candidates) {
  test(`${candidate.name} CANDIDATE proposal is complete, literal and within documented bounds`, () => {
    expect(candidate.config).toEqual(candidate.construction);
    expect(candidate.parameters).toEqual(candidate.expected);
    const bounds: Record<keyof Parameters, readonly [number, number]> = {
      gain: [0, 1], ampAttack: [0, 30], ampDecay: [0, 30], ampSustain: [0, 1], ampRelease: [0, 30],
      pitchAttack: [0, 30], pitchDecay: [0, 30], pitchSustain: [0, 1], pitchRelease: [0, 30],
      filterAttack: [0, 30], filterDecay: [0, 30], filterSustain: [0, 1], filterRelease: [0, 30],
      cutoff: [20, 20000], resonance: [0.5, 10], pitchEnvelopeDepth: [-24, 24], filterEnvelopeDepth: [-8, 8],
      lfoRate: [0, 20], lfoAmpDepth: [0, 1], lfoPitchDepth: [-24, 24], lfoFilterDepth: [-8, 8], bypass: [0, 1],
    };
    expect(Object.keys(candidate.parameters).sort()).toEqual(Object.keys(bounds).sort());
    for (const name of Object.keys(bounds) as (keyof Parameters)[]) {
      expect(Number.isFinite(candidate.parameters[name]), name).toBe(true);
      expect(candidate.parameters[name], name).toBeGreaterThanOrEqual(bounds[name][0]);
      expect(candidate.parameters[name], name).toBeLessThanOrEqual(bounds[name][1]);
    }
  });

  for (const rate of rates) {
    test(`${candidate.name} independent DC ADSR, pitch and cutoff curves at ${rate}`, async () => {
      const p = candidate.expected;
      // Pad starts after the shared LFO is already running and spans its whole
      // 8.333-second cycle. Quantized MIDI times are used by every oracle.
      const begin = candidate.name === 'Pad' ? quantum(0.25, rate) : 0;
      const end = quantum(candidate.name === 'Pad' ? 9 : 0.3, rate);
      const length = endFrame(end + frames(Math.max(p.ampRelease, p.filterRelease), rate) + 256);
      const input = [at(begin, on(36, 100)), at(end, off(36))];
      const amp = await render(probeConfig(candidate.config, 'dc'), candidate.parameters, rate, length, input);
      const reference = (n: number) => Math.fround(p.gain) * (100 / 127) * envelope(p, 'amp', rate, n, begin, end) * tremolo(p, rate, n);
      close(amp.outputs.main[0], reference);
      expect(amp.outputs.main[0].slice(end + frames(p.ampRelease, rate) - 1).every(x => x === 0)).toBe(true);
      expect(() => close(amp.outputs.main[0], n => reference(n) * 0.9)).toThrow();

      // Neutralize only output amplitude to observe the actual candidate pitch
      // and filter controls, including release after the normal amp is silent.
      const probeOverrides = { gain: [1], ampAttack: [0], ampDecay: [0], ampSustain: [1], ampRelease: [30], lfoAmpDepth: [0] };
      const amplitude = (n: number) => n < begin ? 0 : (100 / 127) * (n < end ? 1 : released(n - end, frames(30, rate), 1));
      const pitched = await render(probeConfig(candidate.config, 'frequency'), candidate.parameters, rate, length, input, { params: probeOverrides });
      close(pitched.outputs.main[0], n => amplitude(n) * pitchHz(p, rate, n, 36, envelope(p, 'pitch', rate, n, begin, end)) / 1000);
      const filtered = await render(probeConfig(candidate.config, 'cutoff'), candidate.parameters, rate, length, input, { params: probeOverrides });
      close(filtered.outputs.main[0], n => amplitude(n) * cutoffHz(p, rate, n, envelope(p, 'filter', rate, n, begin, end)) / 20000);

      if (candidate.name === 'Percussion') {
        const decayEnd = frames(0.001, rate) + frames(0.22, rate) - 1;
        expect(amp.outputs.main[0][decayEnd - 1]).toBeGreaterThan(0);
        expect(amp.outputs.main[0].slice(decayEnd).every(x => x === 0)).toBe(true);
        expect(pitched.outputs.main[0][0]).toBeLessThan((100 / 127) * 440 * 2 ** ((36 - 69) / 12) * 4 / 1000);
      }
    }, 60000);

    test(`${candidate.name} reset wins, CC120 cold reallocation, CC123 release and bypass at ${rate}`, async () => {
      const p = candidate.expected, releaseAt = 7 * 128;
      const final = endFrame(releaseAt + frames(p.ampRelease, rate) + 256), length = final + 128;
      const input = [at(0, on(60)), at(3 * 128, cc(123)), at(4 * 128, on(64)), at(5 * 128, on(67)),
        at(6 * 128, cc(120)), at(6 * 128, on(72)), at(releaseAt, cc(123)),
        at(final, on(80, 0)), at(final, on(81)), at(final, off(81))];
      const result = await render(probeConfig(candidate.config, 'dc'), candidate.parameters, rate, length, input, {
        messages: [{ name: 'reset', payload: { value: 1 }, atQuantum: 4 }],
        params: { bypass: Array.from({ length }, (_, n) => n >= 256 && n < 384 ? 1 : 0) },
      });
      close(result.outputs.main[0], n => {
        if (n >= 256 && n < 384 || n >= 512 && n < 640 || n === 768) return 0;
        const a = n < 512 ? envelope(p, 'amp', rate, n, 0, 384)
          : n < 768 ? envelope(p, 'amp', rate, n, 640)
          : envelope(p, 'amp', rate, n, 769, releaseAt);
        return Math.fround(p.gain) * a * tremolo(p, rate, n < 512 ? n : n - 512);
      });
      expect(result.outputs.main[0].slice(releaseAt + frames(p.ampRelease, rate) - 1).every(x => x === 0)).toBe(true);
    }, 30000);
  }

  test(`${candidate.name} same-schema snapshot stays silent and reset plus fresh MIDI restarts cold`, async () => {
    const rate = 48000, processor = createInstrument(candidate.config), parameters = nativeParams(candidate.parameters);
    const warm = await renderOffline(processor, { sampleRate: rate, duration: 4096 / rate, params: parameters, events: [at(0, on(60))] });
    expect(warm.outputs.main[0].some(x => x !== 0)).toBe(true);
    const silent = await renderOffline(processor, { sampleRate: rate, duration: 1024 / rate, params: parameters, restore: warm.state });
    expect(silent.outputs.main[0].every(x => x === 0)).toBe(true);
    const restart = {
      sampleRate: rate, duration: 4096 / rate, params: parameters,
      messages: [{ name: 'reset', payload: { value: 1 }, atQuantum: 0 }],
      events: [at(0, on(64)), at(128, on(67))],
    };
    const cold = await renderOffline(processor, restart);
    const restored = await renderOffline(processor, { ...restart, restore: warm.state });
    expect(restored.outputs.main).toEqual(cold.outputs.main);
    expect(restored.outputs.main[0].slice(0, 128).every(x => x === 0)).toBe(true);
    expect(restored.outputs.main[0].slice(128).some(x => x !== 0)).toBe(true);
    for (const result of [warm, silent, cold, restored]) {
      expect(result.outputs.main[0]).toEqual(result.outputs.main[1]);
      expect(result.outputs.main[0].every(Number.isFinite)).toBe(true);
      expect(result.diagnostics.scrubbedSamples).toBe(0);
    }
  }, 60000);
}

for (const rate of rates) {
  test(`Bass mono legato changes/returns pitch without restarting amp or filter at ${rate}`, async () => {
    const p = expectedBass, end = quantum(0.25, rate), length = endFrame(end + frames(p.ampRelease, rate) + 128);
    const input = [at(0, on(36)), at(128, on(43)), at(256, off(43)), at(end, off(36))];
    for (const probe of ['frequency', 'cutoff'] as const) {
      const result = await render(probeConfig(bassConfig, probe), bassParameters, rate, length, input);
      close(result.outputs.main[0], n => Math.fround(p.gain) * envelope(p, 'amp', rate, n, 0, end) *
        (probe === 'frequency' ? pitchHz(p, rate, n, n >= 128 && n < 256 ? 43 : 36, 0) / 1000
          : cutoffHz(p, rate, n, envelope(p, 'filter', rate, n, 0, end)) / 20000));
    }
  }, 30000);

  test(`Percussion current-level release retrigger keeps the independent pitch/filter sweep at ${rate}`, async () => {
    const p = expectedPercussion, off1 = quantum(0.032, rate), on2 = quantum(0.043, rate), off2 = quantum(0.11, rate);
    const length = endFrame(off2 + frames(0.04, rate) + 128);
    const input = [at(0, on(36, 100)), at(off1, off(36)), at(on2, on(36, 100)), at(off2, off(36))];
    const curve = (target: EnvelopeName, n: number) => {
      const prior = envelope(p, target, rate, on2 - 1, 0, off1);
      return n < on2 ? envelope(p, target, rate, n, 0, off1) : envelope(p, target, rate, n, on2, off2, prior);
    };
    for (const probe of ['dc', 'frequency', 'cutoff'] as const) {
      const result = await render(probeConfig(percussionConfig, probe), percussionParameters, rate, length, input);
      const control = (n: number) => probe === 'frequency' ? pitchHz(p, rate, n, 36, curve('pitch', n)) / 1000
        : probe === 'cutoff' ? cutoffHz(p, rate, n, curve('filter', n)) / 20000 : 1;
      close(result.outputs.main[0], n => Math.fround(p.gain) * (100 / 127) * curve('amp', n) * control(n));
      if (probe === 'dc') {
        const falseZeroStart = Math.fround(p.gain) * (100 / 127) / frames(p.ampAttack, rate);
        expect(result.outputs.main[0][on2]).toBeGreaterThan(falseZeroStart * 2);
      }
      expect(result.outputs.main[0].slice(off2 + frames(p.ampRelease, rate) - 1).every(x => x === 0)).toBe(true);
    }
  }, 30000);

  test(`Pad staggered chord envelopes release independently under one slow free-running LFO at ${rate}`, async () => {
    const p = expectedPad;
    const notes = [48, 55, 60, 64], velocities = [80, 100, 64, 127];
    const starts = [0, 0.5, 1, 1.5].map(t => quantum(t, rate));
    const ends = [4, 5, 6, 7].map(t => quantum(t, rate));
    const length = endFrame(ends[3] + frames(p.ampRelease, rate) + 128);
    const input = notes.flatMap((note, i) => [at(starts[i], on(note, velocities[i])), at(ends[i], off(note))]).sort((a, b) => a.atSample - b.atSample);
    for (const probe of ['frequency', 'cutoff'] as const) {
      const result = await render(probeConfig(padConfig, probe), padParameters, rate, length, input);
      const reference = (n: number, simultaneousOff = false) => notes.reduce((sum, note, i) => {
        const end = simultaneousOff ? ends[0] : ends[i];
        const control = probe === 'frequency' ? pitchHz(p, rate, n, note, 0) / 1000
          : cutoffHz(p, rate, n, envelope(p, 'filter', rate, n, starts[i], end)) / 20000;
        return sum + (velocities[i] / 127) * envelope(p, 'amp', rate, n, starts[i], end) * control;
      }, 0) * Math.fround(p.gain) * tremolo(p, rate, n);
      close(result.outputs.main[0], n => reference(n));
      expect(() => close(result.outputs.main[0], n => reference(n, true))).toThrow();
      expect(result.outputs.main[0][ends[0] + frames(p.ampRelease, rate)]).toBeGreaterThan(0);
      expect(result.outputs.main[0].slice(ends[3] + frames(p.ampRelease, rate) - 1).every(x => x === 0)).toBe(true);
    }
  }, 60000);
}

for (const rate of rates) {
  test(`Pad steal fixture reuses released ownership, steals oldest held and ignores obsolete off64 at ${rate}`, async () => {
    const p = expectedPad;
    // Exact steal timeline from sound-candidates-consumer/fixtures.mjs, including
    // FIFO off60/on72 at q375 and its per-rate quantum-boundary time mapping.
    const q = (value: number) => Math.round(value * rate / 48000) * 128;
    const reuseAt = q(375), stealAt = q(750), obsoleteOffAt = q(1000), releaseAt = q(1250);
    const input = [...[60, 64, 67, 71].map(note => at(0, on(note))),
      at(reuseAt, off(60)), at(reuseAt, on(72)), at(stealAt, on(74)), at(obsoleteOffAt, off(64)),
      ...[67, 71, 72, 74].map(note => at(releaseAt, off(note)))];
    type Levels = { amp: number; filter: number };
    const zero: Levels = { amp: 0, filter: 0 };
    const levels = (n: number, begin = 0, end = releaseAt, start = zero): Levels => ({
      amp: envelope(p, 'amp', rate, n, begin, end, start.amp),
      filter: envelope(p, 'filter', rate, n, begin, end, start.filter),
    });
    // Explicit ownership, not an allocator simulation or captured rendered state:
    // slot 0: 60 -> 72; slot 1: 64 -> 74; slots 2/3 retain 67/71.
    // q375's two MIDI events precede the same first DSP sample, so no release
    // sample occurs between off60 and on72. Both retriggers use the old emitted
    // amp AND filter levels, even though oscillator/filter histories restart.
    const from60 = levels(reuseAt - 1);
    const from64 = levels(stealAt - 1);
    const from72 = levels(stealAt - 1, reuseAt, releaseAt, from60);
    const fromReleased60 = levels(stealAt - 1, 0, reuseAt);
    expect(from60.amp).toBeGreaterThan(0.9);
    expect(from60.filter).toBeGreaterThan(0.7);
    expect(from64.amp).toBeGreaterThan(0.69);
    expect(from64.filter).toBeGreaterThan(0.8);

    for (const probe of ['dc', 'frequency', 'cutoff'] as const) {
      const result = await render(probeConfig(padConfig, probe), padParameters, rate, q(3000), input);
      const contribution = (n: number, note: number, begin = 0, end = releaseAt, start = zero) => {
        const level = levels(n, begin, end, start);
        const control = probe === 'frequency' ? pitchHz(p, rate, n, note, 0) / 1000
          : probe === 'cutoff' ? cutoffHz(p, rate, n, level.filter) / 20000 : 1;
        return level.amp * control;
      };
      const reference = (n: number, wrong?: 'released-slot' | 'oldest-held' | 'obsolete-off' | 'zero-retrigger') => {
        const start60 = wrong === 'zero-retrigger' ? zero : from60;
        const start64 = wrong === 'zero-retrigger' ? zero : from64;
        let slot0 = n < reuseAt ? contribution(n, 60) : contribution(n, 72, reuseAt, releaseAt, start60);
        let slot1 = n < stealAt ? contribution(n, 64) : contribution(n, 74, stealAt,
          wrong === 'obsolete-off' ? obsoleteOffAt : releaseAt, start64);
        if (wrong === 'released-slot') {
          // Wrong alternative: q375 steals held 64 instead of reusing released
          // 60, then q750 reuses 60's remaining release tail for 74.
          slot0 = n < stealAt ? contribution(n, 60, 0, reuseAt)
            : contribution(n, 74, stealAt, releaseAt, fromReleased60);
          slot1 = n < reuseAt ? contribution(n, 64)
            : contribution(n, 72, reuseAt, releaseAt, from60);
        } else if (wrong === 'oldest-held') {
          // Wrong alternative: q750 steals slot 0's newer 72, leaving 64 held.
          if (n >= stealAt) slot0 = contribution(n, 74, stealAt, releaseAt, from72);
          slot1 = contribution(n, 64, 0, obsoleteOffAt);
        }
        return (slot0 + slot1 + contribution(n, 67) + contribution(n, 71)) *
          Math.fround(p.gain) * tremolo(p, rate, n);
      };
      close(result.outputs.main[0], n => reference(n));
      // Each negative is tested only after its disputed transition, avoiding
      // accidental rejection from an unrelated portion of the phrase.
      for (const [wrong, begin, end] of [
        ['released-slot', reuseAt, stealAt],
        ['oldest-held', stealAt, obsoleteOffAt],
        ['obsolete-off', obsoleteOffAt, releaseAt],
        ['zero-retrigger', reuseAt, stealAt],
      ] as const) {
        expect(() => close(result.outputs.main[0].subarray(begin, end), n => reference(n + begin, wrong)), wrong).toThrow();
      }
      if (probe === 'dc') {
        // Remove the analytically known unaffected voices to expose each new
        // owner's first attack step. The same fixed 2e-6 budget also applies
        // here in envelope units; gains are not raised for the probe.
        const summedLevel = (n: number) => result.outputs.main[0][n] /
          (Math.fround(p.gain) * tremolo(p, rate, n));
        const attackFrames = frames(p.ampAttack, rate);
        const first72 = summedLevel(reuseAt) - 3 * levels(reuseAt).amp;
        const first74 = summedLevel(stealAt) - levels(stealAt, reuseAt, releaseAt, from60).amp - 2 * levels(stealAt).amp;
        expect(Math.abs(first72 - (from60.amp + (1 - from60.amp) / attackFrames))).toBeLessThan(2e-6);
        expect(Math.abs(first74 - (from64.amp + (1 - from64.amp) / attackFrames))).toBeLessThan(2e-6);
        expect(first72).toBeGreaterThan(0.9);
        expect(first74).toBeGreaterThan(0.69);
      }
      const silenceAt = releaseAt + frames(p.ampRelease, rate) - 1;
      expect(result.outputs.main[0][silenceAt - 1]).toBeGreaterThan(0);
      expect(result.outputs.main[0].slice(silenceAt).every(x => x === 0)).toBe(true);
    }
  }, 60000);
}
