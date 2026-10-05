import { audioOutput, defineProcessor, forSample, instantiate, param, f32, select } from '@unworklet/core';
import { musicalClock, stepSequence, mseg, randomModulator, sampleAndHold } from '@denaudio/den/modulation';

export default defineProcessor(({ sampleRate }) => {
  const out = audioOutput({ name: 'main', channels: 7 });
  const rate = param.f32({ default: 0, min: 0, max: 1000, automationRate: 'a-rate' }).named('rate');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const seek = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('seek');
  const position = param.f32({ default: 0, min: 0, max: 4, automationRate: 'a-rate' }).named('position');
  const trigger = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('trigger');
  const input = param.f32({ default: .25, min: -1, max: 1, automationRate: 'a-rate' }).named('input');
  const clock = instantiate(musicalClock, { sampleRate, mode: 'free', steps: 4 }, { name: 'clock' });
  const sequence = instantiate(stepSequence, { sampleRate, mode: 'free', steps: [1, 2, 3, 4].map(x => ({ value: x / 4, gate: 1 })) }, { name: 'sequence' });
  const envelope = instantiate(mseg, { sampleRate, initial: -1, segments: [{ seconds: .01, target: 1, curve: 'linear' }] }, { name: 'mseg' });
  const random = instantiate(randomModulator, { seed: 19, initial: .25 }, { name: 'random' });
  const hold = instantiate(sampleAndHold, { initial: 0 }, { name: 'hold' });
  return { process() { forSample(i => {
    const c = { rate: rate.at(i), reset: reset.at(i).gte(.5), seek: seek.at(i).gte(.5), position: position.at(i) };
    const t = clock.tick(c), s = sequence.tick(c), e = envelope.tick({ trigger: trigger.at(i).gte(.5), reset: c.reset });
    const values = [t.step, t.phase, s.value, select(s.gate, f32(1), f32(0)), e.value,
      hold.tick(input.at(i), t.tick, c.reset), random.tick({ trigger: t.tick, reset: c.reset, correlation: f32(.5) })];
    values.forEach((x, channel) => out.ch(channel).at(i).write(x));
  }); } };
});
