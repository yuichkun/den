import type { InstrumentConfig, diagnosticInstrumentParameters } from './instrument.js';

// Plain construction options and native AudioParam values. These are three
// CANDIDATE settings of the same engine, not a preset/serialization format.
type Parameters = { readonly [K in keyof typeof diagnosticInstrumentParameters]: number };

/** CANDIDATE: low saw body, brief filter transient, last-held mono legato. */
export const bassConfig = {
  mode: 'mono', capacity: 1, heldCapacity: 32, legato: true, waveform: 'saw',
} as const satisfies InstrumentConfig;
export const bassParameters = {
  gain: 0.12,
  ampAttack: 0.005, ampDecay: 0.12, ampSustain: 0.7, ampRelease: 0.12,
  pitchAttack: 0, pitchDecay: 0, pitchSustain: 0, pitchRelease: 0,
  filterAttack: 0.003, filterDecay: 0.18, filterSustain: 0.2, filterRelease: 0.12,
  cutoff: 300, resonance: 0.707, pitchEnvelopeDepth: 0, filterEnvelopeDepth: 3,
  lfoRate: 0, lfoAmpDepth: 0, lfoPitchDepth: 0, lfoFilterDepth: 0, bypass: 0,
} as const satisfies Parameters;

/** CANDIDATE: tonal kick/tom body, two-octave pitch drop, retriggered hits. */
export const percussionConfig = {
  mode: 'mono', capacity: 1, heldCapacity: 32, legato: false, waveform: 'sine',
} as const satisfies InstrumentConfig;
export const percussionParameters = {
  gain: 0.16,
  ampAttack: 0.001, ampDecay: 0.22, ampSustain: 0, ampRelease: 0.04,
  pitchAttack: 0, pitchDecay: 0.06, pitchSustain: 0, pitchRelease: 0.04,
  filterAttack: 0, filterDecay: 0.08, filterSustain: 0, filterRelease: 0.04,
  cutoff: 800, resonance: 0.5, pitchEnvelopeDepth: 24, filterEnvelopeDepth: 2,
  lfoRate: 0, lfoAmpDepth: 0, lfoPitchDepth: 0, lfoFilterDepth: 0, bypass: 0,
} as const satisfies Parameters;

/** CANDIDATE: four saw voices, slow rise/release and shared slow modulation. */
export const padConfig = {
  mode: 'poly', capacity: 4, heldCapacity: 32, waveform: 'saw',
} as const satisfies InstrumentConfig;
export const padParameters = {
  gain: 0.045,
  ampAttack: 0.8, ampDecay: 1.2, ampSustain: 0.7, ampRelease: 2.4,
  pitchAttack: 0, pitchDecay: 0, pitchSustain: 0, pitchRelease: 0,
  filterAttack: 1.4, filterDecay: 1.6, filterSustain: 0.5, filterRelease: 2.4,
  cutoff: 1400, resonance: 0.5, pitchEnvelopeDepth: 0, filterEnvelopeDepth: 0.75,
  lfoRate: 0.12, lfoAmpDepth: 0.08, lfoPitchDepth: 0.03, lfoFilterDepth: 0.2, bypass: 0,
} as const satisfies Parameters;
