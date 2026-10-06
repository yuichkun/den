import { audioOutput, defineProcessor, forSample, instantiate, param, f32, bool, state } from '@unworklet/core';
import { envelope } from '@denaudio/den/envelope';

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const attack = param.f32({ default: 0.02, min: 0.001, max: 0.4, automationRate: 'a-rate' }).named('attack');
  const amp = instantiate(envelope, { sampleRate }, { name: 'amp' });
  const phase = state.f32(0).named('phase');
  const beat = state.f32(0).named('beat');
  return { process() { forSample(i => {
    phase.write(phase.read().add(220 / sampleRate).frac());
    beat.write(beat.read().add(2 / sampleRate).frac());
    const level = amp.tick({ gate: beat.read().lt(0.45), retrigger: bool(false), reset: bool(false), attack: attack.at(i), decay: f32(0.12), sustain: f32(0.5), release: f32(0.2) });
    output.ch(0).at(i).write(phase.read().mul(2 * Math.PI).sin().mul(level.level).mul(0.15));
  }); } };
});
