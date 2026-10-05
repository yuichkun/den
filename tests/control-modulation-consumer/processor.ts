import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, select, event, CAPACITY_256, state } from '@unworklet/core';
import { fixedArpeggiator, musicalClock, mseg, randomModulator, sampleAndHold, stepSequence, type MusicalClockControls } from '@denaudio/den/modulation';

export function makeProcessor() {
  return defineProcessor(ctx => {
    const input = audioInput({ channels: 7, name: 'controls' });
    const out = audioOutput({ channels: 10, name: 'main' });
    const clock = instantiate(musicalClock, { sampleRate: ctx.sampleRate, mode: 'tempo', steps: 64, stepsPerBeat: 32 }, { name: 'clock' });
    const sequence = instantiate(stepSequence, { sampleRate: ctx.sampleRate, mode: 'tempo', stepsPerBeat: 32,
      steps: Array.from({ length: 64 }, (_, i) => ({ value: (i - 32) / 32, gate: i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 0.25 })) }, { name: 'sequence' });
    const envelope = instantiate(mseg, { sampleRate: ctx.sampleRate, initial: -1, loop: true,
      segments: Array.from({ length: 16 }, (_, i) => ({ seconds: (i + 1) / ctx.sampleRate, target: (i + 1) / 8 - 1, curve: 'linear' as const })) }, { name: 'mseg' });
    const random = instantiate(randomModulator, { seed: 19, initial: 0.25 }, { name: 'random' });
    const hold = instantiate(sampleAndHold, { initial: 0 }, { name: 'hold' });
    return { process() { forSample(i => {
      const c: MusicalClockControls = { rate: input.ch(0).at(i), reset: input.ch(1).at(i).gt(0), seek: input.ch(2).at(i).gt(0), position: input.ch(3).at(i) };
      const a = clock.tick(c), b = sequence.tick(c);
      const e = envelope.tick({ trigger: input.ch(4).at(i).gt(0), reset: c.reset });
      const r = random.tick({ trigger: a.tick, reset: c.reset, correlation: input.ch(5).at(i) });
      const h = hold.tick(input.ch(6).at(i), a.tick, c.reset);
      [a.step,a.phase,select(a.tick,1,0),b.value,select(b.gate,1,0),e.value,select(e.done,1,0),e.segment,r,h].forEach((x,ch) => out.ch(ch).at(i).write(x));
    }); } };
  });
}


export function makeArpeggiatorProcessor() {
  return defineProcessor(ctx => {
    const output = event.midi({ to: 'main', name: 'notes', capacity: CAPACITY_256 });
    const input = audioInput({ channels: 1, name: 'controls' });
    const audio = audioOutput({ channels: 1, name: 'main' });
    const frame = state.i32(0).named('frame');
    const arp = instantiate(fixedArpeggiator, { sampleRate: ctx.sampleRate, mode: 'free', channel: 0,
      notes: [{ note: 60, velocity: 100, gate: 1 }, { note: 64, velocity: 90, gate: 0.5 }, { note: 67, velocity: 80, gate: 0 }] }, { name: 'arp' });
    return { process() { forSample(i => {
      const value = arp.tick(output, { rate: input.ch(0).at(i), reset: frame.read().gte(1024), seek: bool(false), position: input.ch(0).at(i).mul(0), atSample: frame.read() });
      audio.ch(0).at(i).write(select(value.gate, 1, 0));
      frame.write(frame.read().add(1));
    }); } };
  });
}
