import { audioOutput, i32, defineProcessor, event, f32, forSample, instantiate, param, select, state } from '@unworklet/core';
import { envelope } from './envelope.js';
import { lfo, modulatePitch, modulateCutoff } from './lfo.js';
import { oscillator } from './oscillator.js';
import { filter } from './filter.js';
import { voicePolicy, type VoicePolicyConfig } from './voice-policy.js';

export interface InstrumentConfig extends VoicePolicyConfig {
  waveform?: 'sine' | 'saw';
  /** Compatible unworklet subgraphs, instantiated independently for each voice. */
  oscillator?: typeof oscillator;
  filter?: typeof filter;
}

/** Diagnostic initial AudioParam values, not an approved preset or a preset format. */
export const diagnosticInstrumentParameters = {
  gain: 0.15,
  ampAttack: 0.005,
  ampDecay: 0.08,
  ampSustain: 0.7,
  ampRelease: 0.15,
  pitchAttack: 0,
  pitchDecay: 0.1,
  pitchSustain: 0,
  pitchRelease: 0.1,
  filterAttack: 0.01,
  filterDecay: 0.15,
  filterSustain: 0.2,
  filterRelease: 0.15,
  cutoff: 2500,
  resonance: 0.707,
  pitchEnvelopeDepth: 0,
  filterEnvelopeDepth: 1,
  lfoRate: 2,
  lfoAmpDepth: 0,
  lfoPitchDepth: 0,
  lfoFilterDepth: 0,
  bypass: 0,
} as const;

/** MIDI input `midi`, stereo dual-mono output `main`, panic message `reset`.
 * Capacities/mode/waveform/parts are construction choices; all musical controls
 * use native AudioParams. See docs/instrument.md for timing and reset semantics.
 */
export function createInstrument(config: InstrumentConfig) {
  // Keep the tested compilation ceiling after the initial 32-voice graph
  // exceeded the WASM function-size limit. This is not a real-time guarantee.
  if ((config.capacity ?? (config.mode === 'mono' ? 1 : 4)) > 16) {
    throw new RangeError('instrument capacity must be <= 16 (compiled graph limit)');
  }
  return defineProcessor(({ sampleRate }) => {
    const policy = instantiate(voicePolicy, { ...config, capacity: config.capacity ?? (config.mode === 'mono' ? 1 : 4) }, { name: 'voices' });
    const output = audioOutput({ channels: 2, name: 'main' });
    const midi = event.midi({ from: 'main', name: 'midi' });
    const panic = state.bool(false).expose({ name: 'panic', snapshot: 'transient' });
    const voiceControls = state.buffer.bool({ size: 3 * policy.capacity }).expose({ name: 'voiceControls', snapshot: 'transient' });
    const audioSignals = state.buffer.f32({ size: 2 * policy.capacity }).expose({ name: 'audioSignals', snapshot: 'transient' });
    const completed = state.buffer.bool({ size: policy.capacity }).expose({ name: 'completed', snapshot: 'transient' });
    const cleared = state.buffer.bool({ size: policy.capacity }).expose({ name: 'cleared', snapshot: 'transient' });
    const tuning = state.buffer.f32({ size: 128 }).expose({ name: 'tuning', snapshot: 'transient' });
    const modulation = instantiate(lfo, { sampleRate }, { name: 'lfo' });
    // Materialize intermediate signals: 0.4.1 analysis recursively expands DAGs.
    const signals = state.buffer.f32({ size: 5 * policy.capacity + 1 }).expose({ name: 'signals', snapshot: 'transient' });
    const gain = param.f32({ default: diagnosticInstrumentParameters.gain, min: 0, max: 1, automationRate: 'a-rate' }).named('gain');
    const ampAttack = param.f32({ default: diagnosticInstrumentParameters.ampAttack, min: 0, max: 30, automationRate: 'a-rate' }).named('ampAttack');
    const ampDecay = param.f32({ default: diagnosticInstrumentParameters.ampDecay, min: 0, max: 30, automationRate: 'a-rate' }).named('ampDecay');
    const ampSustain = param.f32({ default: diagnosticInstrumentParameters.ampSustain, min: 0, max: 1, automationRate: 'a-rate' }).named('ampSustain');
    const ampRelease = param.f32({ default: diagnosticInstrumentParameters.ampRelease, min: 0, max: 30, automationRate: 'a-rate' }).named('ampRelease');
    const pitchAttack = param.f32({ default: diagnosticInstrumentParameters.pitchAttack, min: 0, max: 30, automationRate: 'a-rate' }).named('pitchAttack');
    const pitchDecay = param.f32({ default: diagnosticInstrumentParameters.pitchDecay, min: 0, max: 30, automationRate: 'a-rate' }).named('pitchDecay');
    const pitchSustain = param.f32({ default: diagnosticInstrumentParameters.pitchSustain, min: 0, max: 1, automationRate: 'a-rate' }).named('pitchSustain');
    const pitchRelease = param.f32({ default: diagnosticInstrumentParameters.pitchRelease, min: 0, max: 30, automationRate: 'a-rate' }).named('pitchRelease');
    const filterAttack = param.f32({ default: diagnosticInstrumentParameters.filterAttack, min: 0, max: 30, automationRate: 'a-rate' }).named('filterAttack');
    const filterDecay = param.f32({ default: diagnosticInstrumentParameters.filterDecay, min: 0, max: 30, automationRate: 'a-rate' }).named('filterDecay');
    const filterSustain = param.f32({ default: diagnosticInstrumentParameters.filterSustain, min: 0, max: 1, automationRate: 'a-rate' }).named('filterSustain');
    const filterRelease = param.f32({ default: diagnosticInstrumentParameters.filterRelease, min: 0, max: 30, automationRate: 'a-rate' }).named('filterRelease');
    const cutoff = param.f32({ default: diagnosticInstrumentParameters.cutoff, min: 20, max: 20000, automationRate: 'a-rate' }).named('cutoff');
    const resonance = param.f32({ default: diagnosticInstrumentParameters.resonance, min: 0.5, max: 10, automationRate: 'a-rate' }).named('resonance');
    const pitchEnvelopeDepth = param.f32({ default: diagnosticInstrumentParameters.pitchEnvelopeDepth, min: -24, max: 24, automationRate: 'a-rate' }).named('pitchEnvelopeDepth');
    const filterEnvelopeDepth = param.f32({ default: diagnosticInstrumentParameters.filterEnvelopeDepth, min: -8, max: 8, automationRate: 'a-rate' }).named('filterEnvelopeDepth');
    const lfoRate = param.f32({ default: diagnosticInstrumentParameters.lfoRate, min: 0, max: 20, automationRate: 'a-rate' }).named('lfoRate');
    const lfoAmpDepth = param.f32({ default: diagnosticInstrumentParameters.lfoAmpDepth, min: 0, max: 1, automationRate: 'a-rate' }).named('lfoAmpDepth');
    const lfoPitchDepth = param.f32({ default: diagnosticInstrumentParameters.lfoPitchDepth, min: -24, max: 24, automationRate: 'a-rate' }).named('lfoPitchDepth');
    const lfoFilterDepth = param.f32({ default: diagnosticInstrumentParameters.lfoFilterDepth, min: -8, max: 8, automationRate: 'a-rate' }).named('lfoFilterDepth');
    const bypass = param.f32({ default: diagnosticInstrumentParameters.bypass, min: 0, max: 1, automationRate: 'a-rate' }).named('bypass');
    const parts = policy.voices.map((_, index) => ({
      amp: instantiate(envelope, { sampleRate }, { name: `amp${index}` }),
      pitch: instantiate(envelope, { sampleRate }, { name: `pitch${index}` }),
      tone: instantiate(envelope, { sampleRate }, { name: `tone${index}` }),
      oscillator: instantiate(config.oscillator ?? oscillator, { sampleRate, waveform: config.waveform ?? 'sine' }, { name: `oscillator${index}` }),
      filter: instantiate(config.filter ?? filter, { sampleRate }, { name: `filter${index}` }),
    }));
    midi.onEvent('noteOn', e => policy.noteOn(e.note, e.channel, e.velocity));
    midi.onEvent('noteOff', e => policy.noteOff(e.note, e.channel));
    midi.onEvent('cc', e => {
      // Capture ownership before CC120 frees/reassigns voices. A subsequent note
      // in this quantum starts cold, even when it reuses the same physical slot.
      policy.voices.forEach((voice, n) => cleared.write(n, cleared.read(n).or(
        e.controller.eq(120).and(voice.read().channel.eq(e.channel)))));
      // These policy methods have no conditional argument. CC routing uses the
      // policy's validated channel guard for unsupported controller messages.
      policy.allNotesOff(select(e.controller.eq(123), e.channel, i32(-1)));
      policy.allSoundOff(select(e.controller.eq(120), e.channel, i32(-1)));
    });
    event<{ value: number }>({ from: 'main', name: 'reset' }).onReceive(() => panic.write(true));
    return { process() {
      // Reset wins over MIDI delivered in the same block. Its DSP pulse is only
      // the first sample; subsequent blocks may accept fresh notes normally.
      policy.reset(panic.read());
      for (let note = 0; note < 128; note++) tuning.write(note, 440 * 2 ** ((note - 69) / 12));
      forSample(i => {
        const reset = panic.read();
        signals.write(5 * policy.capacity, modulation.tick(lfoRate.at(i), reset, f32(0)));
        let sum = f32(0);
        policy.voices.forEach((voice, n) => {
          const v = voice.read();
          voiceControls.write(n * 3, reset.or(v.active.not()).or(cleared.read(n)));
          voiceControls.write(n * 3 + 1, v.gate.and(voiceControls.read(n * 3).not()));
          voiceControls.write(n * 3 + 2, voice.takeRetrigger());
          const clear = voiceControls.read(n * 3), gate = voiceControls.read(n * 3 + 1), trigger = voiceControls.read(n * 3 + 2);
          const p = parts[n];
          const common = { gate, retrigger: trigger, reset: clear };
          const amp = p.amp.tick({ ...common, attack: ampAttack.at(i), decay: ampDecay.at(i), sustain: ampSustain.at(i), release: ampRelease.at(i) });
          const pitch = p.pitch.tick({ ...common, attack: pitchAttack.at(i), decay: pitchDecay.at(i), sustain: pitchSustain.at(i), release: pitchRelease.at(i) });
          const tone = p.tone.tick({ ...common, attack: filterAttack.at(i), decay: filterDecay.at(i), sustain: filterSustain.at(i), release: filterRelease.at(i) });
          signals.write(n * 5, amp.level);
          signals.write(n * 5 + 1, pitch.level);
          signals.write(n * 5 + 2, tone.level);
          const wave = signals.read(5 * policy.capacity);
          // Combine depths in musical units before the single destination clamp.
          const semitones = signals.read(n * 5 + 1).mul(pitchEnvelopeDepth.at(i)).add(wave.mul(lfoPitchDepth.at(i)));
          const octaves = signals.read(n * 5 + 2).mul(filterEnvelopeDepth.at(i)).add(wave.mul(lfoFilterDepth.at(i)));
          signals.write(n * 5 + 3, modulatePitch(tuning.read(v.note.max(0)), f32(1), semitones, 0.45 * sampleRate));
          signals.write(n * 5 + 4, modulateCutoff(cutoff.at(i), f32(1), octaves, Math.min(20000, 0.45 * sampleRate)));
          audioSignals.write(n * 2, p.oscillator.tick(signals.read(n * 5 + 3), clear.or(trigger)));
          audioSignals.write(n * 2 + 1, p.filter.tick(select(clear, f32(0), audioSignals.read(n * 2)), signals.read(n * 5 + 4), resonance.at(i), clear.or(trigger)));
          const filtered = audioSignals.read(n * 2 + 1);
          // Unipolar tremolo: depth 0 is unity; depth 1 spans 0..1.
          const tremolo = f32(1).sub(lfoAmpDepth.at(i).mul(f32(1).sub(wave)).mul(0.5));
          const sample = select(v.active.and(clear.not()), filtered.mul(signals.read(n * 5)).mul(v.velocity).mul(tremolo), f32(0));
          sum = sum.add(sample);
          completed.write(n, amp.done);
          cleared.write(n, 0);
        });
        const result = select(bypass.at(i).gte(0.5).or(reset), f32(0), sum.mul(gain.at(i)));
        output.ch(0).at(i).write(result);
        output.ch(1).at(i).write(result);
        panic.write(false);
      });
      // MIDI is drained only before process(). Once the amp reaches zero it
      // stays done for the rest of this block. Free completed allocations here,
      // before the next MIDI dispatch, instead of doing O(voices²) rank updates
      // on every sample. Audio termination remains on the exact envelope sample.
      policy.voices.forEach((voice, n) => voice.releaseFinished(completed.read(n)));
    } };
  });
}

/** Diagnostic default: four voices, configurable at construction. */
export const instrument = createInstrument({ mode: 'poly' });
