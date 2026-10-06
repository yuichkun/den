import { audioOutput, defineProcessor, f32, forSample, i32, instantiate, param, select, state } from '@unworklet/core';
import { curvedAdsr, musicalLfo, type MusicalLfoWaveform } from '@denaudio/den/musical-controls';
import { musicalClock } from '@denaudio/den/modulation';

export default defineProcessor(({ sampleRate }) => {
  const envelope = instantiate(curvedAdsr, { sampleRate }, { name: 'curved' });
  const waves = (['sine', 'triangle', 'saw', 'square'] as MusicalLfoWaveform[]).map(waveform =>
    instantiate(musicalLfo, { sampleRate, mode: 'free', waveform }, { name: waveform }));
  const tempo = instantiate(musicalLfo, { sampleRate, mode: 'tempo', waveform: 'sine', beatsPerCycle: .5 }, { name: 'tempo' });
  const clock = instantiate(musicalClock, { sampleRate, mode: 'free', steps: 3 }, { name: 'threeStep' });
  const frame = state.i32(0).named('frame');
  const rate = param.f32({ default: 3.125, min: 0, max: 20, automationRate: 'a-rate' }).named('rate');
  const bpm = param.f32({ default: 120, min: 0, max: 1000, automationRate: 'a-rate' }).named('bpm');
  const hold = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('hold');
  const seek = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('seek');
  const position = param.f32({ default: 0, min: -1048576, max: 1048576, automationRate: 'a-rate' }).named('position');
  const offset = param.f32({ default: 0, min: -1048576, max: 1048576, automationRate: 'a-rate' }).named('offset');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const bend = param.f32({ default: .75, min: -1, max: 1, automationRate: 'a-rate' }).named('bend');
  const output = audioOutput({ name: 'main', channels: 23 });
  return { process() { forSample(i => {
    const values = [rate.at(i), bpm.at(i), hold.at(i), seek.at(i), position.at(i), offset.at(i), reset.at(i), bend.at(i)];
    const clear = values[6].gte(.5), now = select(clear, i32(0), frame.read());
    const env = envelope.tick({ gate: now.gte(1).and(now.lte(384)), retrigger: now.eq(256), reset: clear.or(now.eq(0)),
      attack: f32(64 / sampleRate), decay: f32(96 / sampleRate), sustain: f32(.375), release: f32(128 / sampleRate),
      attackBend: values[7], decayBend: values[7].neg(), releaseBend: values[7] });
    const c = { rate: values[0], hold: values[2].gte(.5), seek: values[3].gte(.5), position: values[4], phaseOffset: values[5], reset: clear };
    const free = waves.flatMap(wave => { const result = wave.tick(c); return [result.value, result.phase]; });
    const t = tempo.tick({ ...c, rate: values[1] });
    const step = clock.tick({ rate: select(c.hold, f32(0), values[0]), reset: clear, seek: c.seek, position: c.position });
    [env.level, f32(env.done), f32(now), ...free, t.value, t.phase, step.step, step.phase, ...values].forEach((value, channel) => output.ch(channel).at(i).write(value));
    frame.write(select(clear, i32(0), now.add(1).mod(1024)));
  }); } };
}, { id: 'den.musical-controls.browser' });
