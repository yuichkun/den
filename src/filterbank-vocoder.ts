import { defineSubgraph, f32, f64, instantiate, select, type Node } from '@unworklet/core';
import { stateVariableFilter } from './state-variable-filter.js';
import { envelopeFollower } from './dynamics.js';
import { checkedSampleRate } from './catalog-filter-math.js';

export interface FilterBankVocoderBand {
  /** Fixed center in [20, min(20000, .45 * sampleRate)] Hz. */
  frequencyHz: number;
  /** Fixed Q in [.5, 10]; each analysis/synthesis bandpass has unity peak. */
  q: number;
  /** Explicit linear synthesis gain in [0, 4], with no band-count normalization. */
  gain: number;
}
export interface FilterBankVocoderConfig {
  /** Integer in [8000, 192000] Hz; must match the processing sample rate. */
  sampleRate: number;
  /** 1–8 fixed bands with strictly increasing centers; sparse arrays are invalid. */
  bands: readonly FilterBankVocoderBand[];
}
export interface FilterBankVocoderControls {
  /** Envelope time constants in seconds: zero immediate, positive at least one sample, maximum 30 s. */
  attack: Node<'f32'>;
  release: Node<'f32'>;
  /** Clears both banks and every detector before processing this sample. */
  reset: Node<'bool'>;
}
export interface FilterBankVocoderOutput {
  output: Node<'f32'>;
  /** Uncalibrated rectified-amplitude envelopes in configuration order. */
  envelopes: readonly Node<'f32'>[];
}

function finiteAudio(input: Node<'f32'>) {
  return select(input.eq(input).and(input.abs().lte(3.4028234663852886e38)), input, f32(0));
}

/**
 * Mono fixed filter-bank vocoder: sum(gain * carrier bandpass * modulator envelope).
 * No carrier source, dry mix, limiter, automatic normalization, or speech-quality promise.
 */
export const filterBankVocoder = defineSubgraph((config: FilterBankVocoderConfig) => {
  const maximum = checkedSampleRate(config.sampleRate);
  if (!Number.isInteger(config.sampleRate)) throw new RangeError('vocoder sampleRate must be an integer');
  if (!Array.isArray(config.bands) || config.bands.length < 1 || config.bands.length > 8) {
    throw new RangeError('vocoder requires 1–8 fixed, densely specified bands');
  }
  let previous = 0;
  // Validate every index before creating any state; Array#map alone skips holes.
  for (const band of config.bands) {
    if (band === null || typeof band !== 'object' ||
        !Number.isFinite(band.frequencyHz) || band.frequencyHz < 20 || band.frequencyHz > maximum || band.frequencyHz <= previous ||
        !Number.isFinite(band.q) || band.q < .5 || band.q > 10 ||
        !Number.isFinite(band.gain) || band.gain < 0 || band.gain > 4) {
      throw new RangeError('vocoder bands require increasing bounded frequencyHz, Q, and gain');
    }
    previous = band.frequencyHz;
  }
  const bands = config.bands.map((band, index) => ({
    frequency: f32(band.frequencyHz), q: f32(band.q), gain: band.gain,
    analysis: instantiate(stateVariableFilter, { sampleRate: config.sampleRate }, { name: `analysis${index}` }),
    synthesis: instantiate(stateVariableFilter, { sampleRate: config.sampleRate }, { name: `synthesis${index}` }),
    detector: instantiate(envelopeFollower, { sampleRate: config.sampleRate, mode: 'peak' }, { name: `envelope${index}` }),
  }));
  return {
    /** Exactly once per sample. NaN/±Infinity audio becomes zero; finite audio is not clipped. */
    tick(modulator: Node<'f32'>, carrier: Node<'f32'>, controls: FilterBankVocoderControls): FilterBankVocoderOutput {
      const analysisInput = finiteAudio(modulator), synthesisInput = finiteAudio(carrier);
      const envelopes: Node<'f32'>[] = [];
      let sum = f64(0);
      for (const band of bands) {
        const analysis = band.analysis.tick(analysisInput, band.frequency, band.q, controls.reset).bandpass;
        const synthesis = band.synthesis.tick(synthesisInput, band.frequency, band.q, controls.reset).bandpass;
        const envelope = band.detector.tick(analysis, controls);
        envelopes.push(envelope);
        sum = sum.add(f64(synthesis).mul(f64(envelope)).mul(band.gain));
      }
      return { output: f32(sum), envelopes };
    },
  };
});
