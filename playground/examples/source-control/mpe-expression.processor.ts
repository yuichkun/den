import { audioOutput, defineProcessor, event, f32, forSample, instantiate, select, state } from '@unworklet/core';
import { mpeExpression } from '@denaudio/den/mpe-expression';
import { voicePolicy } from '@denaudio/den/voice-policy';
import { tunedFrequency } from '@denaudio/den/performance';
import { oscillator } from '@denaudio/den/oscillator';

// Lower zone: channel 0 is master; channel 1 is a member. These are native MIDI messages.
export const midi = [
  { port: 'midi', event: { type: 'noteOn', channel: 1, note: 57, velocity: 100 } },
  { port: 'midi', event: { type: 'pitchBend', channel: 1, value: 9000 } },
  { port: 'midi', event: { type: 'channelPressure', channel: 1, pressure: 100 } },
  { port: 'midi', event: { type: 'cc', channel: 1, controller: 74, value: 90 } },
];
export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const policy = instantiate(voicePolicy, { mode: 'mono', heldCapacity: 4 }, { name: 'voices' });
  const expression = instantiate(mpeExpression, { memberChannels: 1, memberBendRange: 12, masterBendRange: 2 }, { name: 'expression' });
  const input = event.midi({ from: 'main', name: 'midi' });
  policy.bindMidi(input); expression.bindMidi(input);
  const source = instantiate(oscillator, { sampleRate, waveform: 'sine' }, { name: 'source' });
  const note = state.f32(57).named('note'), frequency = state.f32(220).named('frequency');
  return { process() { forSample(i => {
    const voice = policy.voices[0], v = voice.read(), e = expression.read(v);
    note.write(f32(v.note).add(e.bendSemitones));
    frequency.write(tunedFrequency({ note: note.read(), transpose: f32(0), cents: f32(0), a4: f32(440) }, 0.45 * sampleRate));
    const wave = source.tick(frequency.read(), voice.takeRetrigger());
    const gain = e.memberPressure.mul(0.5).add(0.5).mul(e.memberTimbre.mul(0.25).add(0.75));
    output.ch(0).at(i).write(select(v.gate.and(e.inZone), wave.mul(gain).mul(v.velocity).mul(0.2), f32(0)));
  }); } };
});
