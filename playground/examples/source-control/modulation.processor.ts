import { audioOutput, bool, defineProcessor, f32, forSample, instantiate, param, state } from '@unworklet/core';
import { stepSequence } from '@denaudio/den/modulation';
import { tunedFrequency } from '@denaudio/den/performance';
import { oscillator } from '@denaudio/den/oscillator';
import { envelope } from '@denaudio/den/envelope';

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const bpm = param.f32({ default: 108, min: 40, max: 200, automationRate: 'a-rate' }).named('bpm');
  const sequence = instantiate(stepSequence, { sampleRate, mode: 'tempo', stepsPerBeat: 2,
    steps: [0, 3, 7, 10].map(semitones => ({ value: semitones / 12, gate: 0.65 })) }, { name: 'sequence' });
  const source = instantiate(oscillator, { sampleRate, waveform: 'saw' }, { name: 'source' });
  const amp = instantiate(envelope, { sampleRate }, { name: 'amp' });
  const frequency = state.f32(220).named('frequency');
  return { process() { forSample(i => {
    const step = sequence.tick({ rate: bpm.at(i), reset: bool(false), seek: bool(false), position: f32(0) });
    frequency.write(tunedFrequency({ note: step.value.mul(12).add(57), transpose: f32(0), cents: f32(0), a4: f32(440) }, 0.45 * sampleRate));
    const env = amp.tick({ gate: step.gate, retrigger: bool(false), reset: bool(false),
      attack: f32(0.008), decay: f32(0.05), sustain: f32(0.65), release: f32(0.06) });
    output.ch(0).at(i).write(source.tick(frequency.read(), bool(false)).mul(env.level).mul(0.16));
  }); } };
});
