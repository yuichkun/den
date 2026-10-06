import { audioOutput, bool, defineProcessor, f32, forSample, instantiate, select } from '@unworklet/core';
import { modalResonator } from '@denaudio/den/resonator';
import { musicalClock } from '@denaudio/den/modulation';

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const clock = instantiate(musicalClock, { sampleRate, mode: 'free', steps: 1 }, { name: 'clock' });
  const bell = instantiate(modalResonator, { sampleRate, modes: [
    { frequencyHz: 330, decaySeconds: 0.8, gain: 1 },
    { frequencyHz: 892, decaySeconds: 0.4, gain: 0.5 },
    { frequencyHz: 1749, decaySeconds: 0.2, gain: 0.25 },
  ] }, { name: 'bell' });
  return { process() { forSample(i => {
    const beat = clock.tick({ rate: f32(1.5), reset: bool(false), seek: bool(false), position: f32(0) });
    // Reset per strike bounds each impulse response and prevents tail accumulation.
    const ring = bell.tick(select(beat.tick, f32(1), f32(0)), beat.tick);
    output.ch(0).at(i).write(ring.mul(0.2));
  }); } };
});
