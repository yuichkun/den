import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { filterBankVocoder } from '@denaudio/den/filterbank-vocoder';
import { oscillator } from '@denaudio/den/oscillator';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const carrierHz = param.f32({ default: 110, min: 55, max: 440, automationRate: 'a-rate' }).named('carrierHz');
  const release = param.f32({ default: 0.08, min: 0.01, max: 0.5, automationRate: 'a-rate' }).named('release');
  const carrier = instantiate(oscillator, { sampleRate, waveform: 'saw' }, { name: 'carrier' });
  const vocoder = instantiate(filterBankVocoder, { sampleRate, bands: [
    { frequencyHz: 220, q: 2, gain: 2 },
    { frequencyHz: 660, q: 3, gain: 2 },
    { frequencyHz: 1320, q: 4, gain: 2 },
    { frequencyHz: 2640, q: 5, gain: 2 },
  ] }, { name: 'vocoder' });
  return { process() { forSample(i => {
    // The host input is the modulator; this explicit saw is the carrier.
    // No microphone, speech model, automatic normalization or dry bypass.
    const tone = carrier.tick(carrierHz.at(i), bool(false)).mul(0.4);
    const wet = vocoder.tick(input.ch(0).at(i).mul(2), tone, {
      attack: f32(0.005), release: release.at(i), reset: bool(false),
    });
    output.ch(0).at(i).write(wet.output);
  }); } };
});
