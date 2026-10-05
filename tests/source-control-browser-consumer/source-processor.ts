import { audioOutput, defineProcessor, forSample, instantiate, param, f32, select } from '@unworklet/core';
import { phaseModulation, frequencyModulation, additiveSource, unisonSource } from '@denaudio/den/source';
import { modalResonator, tunedComb } from '@denaudio/den/resonator';

// A small functional browser graph; maximum-capacity cost is measured separately.
export default defineProcessor(({ sampleRate }) => {
  const out = audioOutput({ name: 'main', channels: 7 });
  const frequency = param.f32({ default: 375, min: 0, max: 1000, automationRate: 'a-rate' }).named('frequency');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const pm = instantiate(phaseModulation, { sampleRate }, { name: 'pm' });
  const fm = instantiate(frequencyModulation, { sampleRate }, { name: 'fm' });
  const additive = instantiate(additiveSource, { sampleRate, partials: [{ ratio: 1, gain: 1 }, { ratio: 2, gain: .5 }] }, { name: 'additive' });
  const unison = instantiate(unisonSource, { sampleRate, waveform: 'sine', voices: [{ detuneCents: 0, pan: 0 }] }, { name: 'unison' });
  const modal = instantiate(modalResonator, { sampleRate, modes: [{ frequencyHz: 1000, decaySeconds: .05, gain: 1 }, { frequencyHz: 2000, decaySeconds: .05, gain: .5 }] }, { name: 'modal' });
  const comb = instantiate(tunedComb, { sampleRate, minFrequencyHz: 100 }, { name: 'comb' });
  return { process() { forSample(i => {
    const clear = reset.at(i).gte(.5), hz = frequency.at(i), input = select(clear, f32(0), f32(.01));
    const stereo = unison.tick(hz, clear);
    const values = [
      pm.tick({ carrierHz: hz, modulatorHz: f32(125), depthRadians: f32(0), feedbackRadians: f32(0), reset: clear }),
      fm.tick({ carrierHz: hz, modulatorHz: f32(125), deviationHz: f32(0), feedbackHz: f32(0), reset: clear }),
      additive.tick(hz, clear), stereo.left, stereo.right, modal.tick(input, clear),
      comb.tick({ input, frequencyHz: f32(750), feedback: f32(.5), damping: f32(0), reset: clear }),
    ];
    values.forEach((x, channel) => out.ch(channel).at(i).write(x));
  }); } };
});
