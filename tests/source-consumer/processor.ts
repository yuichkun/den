import { audioOutput, bool, defineProcessor, f32, forSample, instantiate, select, state } from '@unworklet/core';
import { additiveSource, frequencyModulation, phaseModulation, unisonSource, type AdditivePartial, type UnisonVoice } from '@denaudio/den/source';
import { modalResonator, tunedComb, type ResonatorMode } from '@denaudio/den/resonator';
import { envelope } from '@denaudio/den/envelope';

export const partials: AdditivePartial[] = Array.from({ length: 32 }, (_, i) => ({ ratio: i + 1, gain: 1 / (i + 1) }));
export const voices: UnisonVoice[] = Array.from({ length: 8 }, (_, i) => ({ detuneCents: (i - 3.5) * 8, pan: (i - 3.5) / 3.5 }));
export const modes: ResonatorMode[] = Array.from({ length: 16 }, (_, i) => ({ frequencyHz: 300 + i * 111, decaySeconds: 0.2 + i * 0.01, gain: 1 / (i + 1) }));
export const makeProcessor = () => defineProcessor(ctx => {
  const sampleRate = ctx.sampleRate;
  const pm = instantiate(phaseModulation, { sampleRate }, { name: 'pm' });
  const fm = instantiate(frequencyModulation, { sampleRate }, { name: 'fm' });
  const additive = instantiate(additiveSource, { sampleRate, partials }, { name: 'additive' });
  const unison = instantiate(unisonSource, { sampleRate, waveform: 'sine', voices }, { name: 'unison' });
  const modal = instantiate(modalResonator, { sampleRate, modes }, { name: 'modal' });
  const comb = instantiate(tunedComb, { sampleRate, minFrequencyHz: 20 }, { name: 'comb' });
  const env = instantiate(envelope, { sampleRate }, { name: 'envelope' });
  const frame = state.i32(0).named('frame');
  const output = audioOutput({ channels: 8, name: 'main' });
  return { process() { forSample(i => {
    const n = frame.read(), reset = bool(false), excitation = select(n.eq(0), f32(1), f32(0));
    output.ch(0).at(i).write(pm.tick({ carrierHz: f32(440), modulatorHz: f32(110), depthRadians: f32(2), feedbackRadians: f32(0), reset }));
    output.ch(1).at(i).write(fm.tick({ carrierHz: f32(440), modulatorHz: f32(110), deviationHz: f32(220), feedbackHz: f32(0), reset }));
    output.ch(2).at(i).write(additive.tick(f32(110), reset));
    const pair = unison.tick(f32(220), reset);
    output.ch(3).at(i).write(pair.left); output.ch(4).at(i).write(pair.right);
    output.ch(5).at(i).write(modal.tick(excitation, reset));
    output.ch(6).at(i).write(comb.tick({ input: excitation, frequencyHz: f32(sampleRate / 64), feedback: f32(0.5), damping: f32(0), reset }));
    const level = env.tick({ gate: n.lt(1024), retrigger: bool(false), reset, attack: f32(32 / sampleRate), decay: f32(32 / sampleRate), sustain: f32(0.5), release: f32(64 / sampleRate) }).level;
    output.ch(7).at(i).write(pair.left.add(pair.right).mul(level));
    frame.write(n.add(1));
  }); } };
});
