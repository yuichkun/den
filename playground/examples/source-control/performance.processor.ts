import { audioOutput, bool, defineProcessor, f32, forSample, instantiate, param, state } from '@unworklet/core';
import { pitchGlide, tunedFrequency } from '@denaudio/den/performance';
import { stepSequence } from '@denaudio/den/modulation';
import { oscillator } from '@denaudio/den/oscillator';

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const seconds = param.f32({ default: 0.18, min: 0, max: 1, automationRate: 'a-rate' }).named('glideSeconds');
  const sequence = instantiate(stepSequence, { sampleRate, mode: 'free', steps: [0, 12, 7, 15].map(semitones => ({ value: semitones / 24, gate: 1 })) }, { name: 'sequence' });
  const glide = instantiate(pitchGlide, { sampleRate }, { name: 'glide' });
  const source = instantiate(oscillator, { sampleRate, waveform: 'saw' }, { name: 'source' });
  const note = state.f32(45).named('note'), frequency = state.f32(110).named('frequency');
  return { process() { forSample(i => {
    const step = sequence.tick({ rate: f32(2), reset: bool(false), seek: bool(false), position: f32(0) });
    note.write(glide.tick({ target: step.value.mul(24).add(45), seconds: seconds.at(i), reset: bool(false), snap: bool(false) }));
    // Glide is in MIDI semitones; tune only after gliding.
    frequency.write(tunedFrequency({ note: note.read(), transpose: f32(0), cents: f32(0), a4: f32(440) }, 0.45 * sampleRate));
    output.ch(0).at(i).write(source.tick(frequency.read(), bool(false)).mul(0.15));
  }); } };
});
