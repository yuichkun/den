import { defineSubgraph, f32, instantiate, type Node } from '@unworklet/core';
import { stateVariableFilter } from './state-variable-filter.js';
import { checkedSampleRate } from './catalog-filter-math.js';

export interface FormantBand { frequencyHz: number; q: number; gain: number }
export interface FormantBankConfig { sampleRate: number; bands: readonly FormantBand[] }

/** Fixed 1–8 parallel, unity-peak bandpasses. A resonator bank, not a speech synthesizer. */
export const formantBank = defineSubgraph((config: FormantBankConfig) => {
  const maximum = checkedSampleRate(config.sampleRate);
  if (!Array.isArray(config.bands) || config.bands.length < 1 || config.bands.length > 8) throw new RangeError('formant bank requires 1–8 fixed bands');
  const bands = config.bands.map((band, index) => {
    if (!Number.isFinite(band.frequencyHz) || band.frequencyHz < 20 || band.frequencyHz > maximum ||
        !Number.isFinite(band.q) || band.q < .5 || band.q > 10 || !Number.isFinite(band.gain) || Math.abs(band.gain) > 1) {
      throw new RangeError('formant band frequency/Q/gain is outside its supported bounds');
    }
    return {frequencyHz: band.frequencyHz, q: band.q, gain: band.gain,
      filter: instantiate(stateVariableFilter, {sampleRate:config.sampleRate}, {name:`band${index}`})};
  });
  return {
    /** Linear frequency ratio [.25,4] and Q scale [.25,4]; per-band cutoff/Q limits still apply. */
    tick(input: Node<'f32'>, frequencyRatio: Node<'f32'>, resonanceScale: Node<'f32'>, reset: Node<'bool'>) {
      let output = f32(0);
      for (const band of bands) {
        const response = band.filter.tick(input, frequencyRatio.clamp(.25,4).mul(band.frequencyHz), resonanceScale.clamp(.25,4).mul(band.q), reset);
        output = output.add(response.bandpass.mul(band.gain));
      }
      return output;
    },
  };
});
