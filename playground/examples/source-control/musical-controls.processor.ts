import { audioOutput, bool, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { curvedAdsr, musicalLfo } from '@denaudio/den/musical-controls';
import { oscillator } from '@denaudio/den/oscillator';

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const bend = param.f32({ default: 0.75, min: -1, max: 1, automationRate: 'a-rate' }).named('attackBend');
  const bpm = param.f32({ default: 120, min: 40, max: 180, automationRate: 'a-rate' }).named('bpm');
  const clock = instantiate(musicalLfo, { sampleRate, mode: 'tempo', waveform: 'square', beatsPerCycle: 1 }, { name: 'clock' });
  const amp = instantiate(curvedAdsr, { sampleRate }, { name: 'amp' });
  const source = instantiate(oscillator, { sampleRate, waveform: 'saw' }, { name: 'source' });
  return { process() { forSample(i => {
    const beat = clock.tick({ rate: bpm.at(i), reset: bool(false), seek: bool(false), position: f32(0), phaseOffset: f32(0), hold: bool(false) });
    const env = amp.tick({ gate: beat.value.gt(0), retrigger: bool(false), reset: bool(false),
      attack: f32(0.07), decay: f32(0.1), sustain: f32(0.4), release: f32(0.16),
      attackBend: bend.at(i), decayBend: f32(-0.6), releaseBend: f32(0.6) });
    output.ch(0).at(i).write(source.tick(f32(220), bool(false)).mul(env.level).mul(0.17));
  }); } };
});
