import { audioOutput, bool, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { envelope } from '@denaudio/den/envelope';
import { oscillator } from '@denaudio/den/oscillator';
import { musicalClock } from '@denaudio/den/modulation';

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const attack = param.f32({ default: 0.015, min: 0, max: 0.25, automationRate: 'a-rate' }).named('attack');
  const release = param.f32({ default: 0.12, min: 0, max: 0.5, automationRate: 'a-rate' }).named('release');
  const clock = instantiate(musicalClock, { sampleRate, mode: 'free', steps: 1 }, { name: 'clock' });
  const amp = instantiate(envelope, { sampleRate }, { name: 'amp' });
  const voice = instantiate(oscillator, { sampleRate, waveform: 'saw' }, { name: 'voice' });
  return { process() { forSample(i => {
    const beat = clock.tick({ rate: f32(2), reset: bool(false), seek: bool(false), position: f32(0) });
    // Each cycle holds the gate for 60%; the remaining time exposes the release.
    const level = amp.tick({ gate: beat.phase.lt(0.6), retrigger: bool(false), reset: bool(false),
      attack: attack.at(i), decay: f32(0.08), sustain: f32(0.55), release: release.at(i) });
    output.ch(0).at(i).write(voice.tick(f32(220), bool(false)).mul(level.level).mul(0.18));
  }); } };
});
