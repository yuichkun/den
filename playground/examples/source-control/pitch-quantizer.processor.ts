import { audioOutput, bool, defineProcessor, f32, forSample, instantiate, param, state } from '@unworklet/core';
import { pitchQuantizer } from '@denaudio/den/pitch-quantizer';
import { lfo } from '@denaudio/den/lfo';
import { tunedFrequency } from '@denaudio/den/performance';
import { oscillator } from '@denaudio/den/oscillator';

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const rate = param.f32({ default: 0.25, min: 0, max: 2, automationRate: 'a-rate' }).named('sweepRate');
  const quantizer = instantiate(pitchQuantizer, { pitchClasses: [0, 2, 4, 7, 9], hysteresis: 0.1 }, { name: 'pentatonic' });
  const sweep = instantiate(lfo, { sampleRate }, { name: 'sweep' });
  const source = instantiate(oscillator, { sampleRate, waveform: 'sine' }, { name: 'source' });
  const note = state.f32(60).named('note'), frequency = state.f32(220).named('frequency');
  return { process() { forSample(i => {
    const continuous = sweep.tick(rate.at(i), bool(false), f32(0)).mul(12).add(60);
    // This quantizes a pitch-control signal; it does not detect pitch from audio.
    note.write(quantizer.tick(continuous, bool(false)).pitch);
    frequency.write(tunedFrequency({ note: note.read(), transpose: f32(0), cents: f32(0), a4: f32(440) }, 0.45 * sampleRate));
    output.ch(0).at(i).write(source.tick(frequency.read(), bool(false)).mul(0.15));
  }); } };
});
