import { audioOutput, defineProcessor, event, f32, forSample, instantiate, select, state } from '@unworklet/core';
import { voicePolicy } from '@denaudio/den/voice-policy';
import { envelope } from '@denaudio/den/envelope';
import { oscillator } from '@denaudio/den/oscillator';

// Native MIDI ingress. No device is required; edit the note and Run again.
export const midi = [{ port: 'midi', event: { type: 'noteOn', channel: 0, note: 57, velocity: 96 } }];
export default defineProcessor(({ sampleRate }) => {
  const policy = instantiate(voicePolicy, { mode: 'mono', heldCapacity: 4, legato: true }, { name: 'voices' });
  policy.bindMidi(event.midi({ from: 'main', name: 'midi' }));
  const output = audioOutput({ name: 'main', channels: 1 });
  const amp = instantiate(envelope, { sampleRate }, { name: 'amp' });
  const source = instantiate(oscillator, { sampleRate, waveform: 'saw' }, { name: 'source' });
  const tuning = state.buffer.f32({ size: 128 }).expose({ name: 'tuning', snapshot: 'transient' });
  const complete = state.bool(true).expose({ name: 'complete', snapshot: 'transient' });
  return { process() {
    for (let note = 0; note < 128; note++) tuning.write(note, 440 * 2 ** ((note - 69) / 12));
    forSample(i => {
      const voice = policy.voices[0], v = voice.read(), trigger = voice.takeRetrigger();
      const env = amp.tick({ gate: v.gate, retrigger: trigger, reset: v.active.not(),
        attack: f32(0.015), decay: f32(0.1), sustain: f32(0.65), release: f32(0.15) });
      const wave = source.tick(tuning.read(v.note.max(0)), trigger);
      output.ch(0).at(i).write(select(v.active, wave.mul(env.level).mul(v.velocity).mul(0.18), f32(0)));
      complete.write(env.done);
    });
    policy.voices[0].releaseFinished(complete.read());
  } };
});
