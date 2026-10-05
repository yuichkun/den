import { audioInput, audioOutput, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { filterBankVocoder, type FilterBankVocoderConfig } from '@denaudio/den/filterbank-vocoder';
export function makeProcessor(config: FilterBankVocoderConfig = { sampleRate: 48000, bands: [{ frequencyHz: 1000, q: 4, gain: 1 }] }) {
  return defineProcessor(() => {
    const input = audioInput({ name: 'main', channels: 5 }), output = audioOutput({ name: 'main', channels: config.bands.length + 1 });
    const unit = instantiate(filterBankVocoder, config, { name: 'vocoder' });
    return { process() { forSample(i => {
      const y = unit.tick(input.ch(0).at(i), input.ch(1).at(i), { attack: input.ch(2).at(i), release: input.ch(3).at(i), reset: input.ch(4).at(i).gt(0) });
      [y.output, ...y.envelopes].forEach((x, ch) => output.ch(ch).at(i).write(x));
    }); } };
  }, { id: `den.filterbank-vocoder.consumer.${config.sampleRate}.${config.bands.length}` });
}
// Browser-only composition: saved controls and their rendered values are native.
// The independent three-rate bank oracle above retains its original five inputs.
export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 2 });
  const output = audioOutput({ name: 'main', channels: 7 });
  const unit = instantiate(filterBankVocoder, { sampleRate, bands: [{ frequencyHz: 1000, q: 4, gain: 1 }] }, { name: 'vocoder' });
  const modulatorGain = param.f32({ default: 1, min: 0, max: 2, automationRate: 'a-rate' }).named('modulatorGain');
  const carrierGain = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('carrierGain');
  const attack = param.f32({ default: .01, min: 0, max: 30, automationRate: 'a-rate' }).named('attack');
  const release = param.f32({ default: .01, min: 0, max: 30, automationRate: 'a-rate' }).named('release');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  return { process() { forSample(i => {
    const controls = [modulatorGain.at(i), carrierGain.at(i), attack.at(i), release.at(i), reset.at(i)];
    const y = unit.tick(input.ch(0).at(i).mul(controls[0]), input.ch(1).at(i).mul(controls[1]), { attack: controls[2], release: controls[3], reset: controls[4].gt(0) });
    [y.output, y.envelopes[0], ...controls].forEach((value, channel) => output.ch(channel).at(i).write(value));
  }); } };
}, { id: 'den.filterbank-vocoder.browser' });
