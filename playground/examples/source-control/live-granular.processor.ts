import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { liveSampleBuffer } from '@denaudio/den/live-buffer';
import { liveGranularSource } from '@denaudio/den/live-granular';
import { musicalClock } from '@denaudio/den/modulation';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const rate = param.f32({ default: 0.75, min: -1, max: 1, automationRate: 'a-rate' }).named('rate');
  const history = instantiate(liveSampleBuffer, { capacity: 16384, sampleRate }, { name: 'history' });
  const grains = instantiate(liveGranularSource, { history, maxGrains: 4 }, { name: 'grains' });
  const clock = instantiate(musicalClock, { sampleRate, mode: 'free', steps: 1 }, { name: 'clock' });
  return { process() { forSample(i => {
    const reset = bool(false);
    const written = history.tick({ input: input.ch(0).at(i), record: bool(true), reset });
    const beat = clock.tick({ rate: f32(40), reset, seek: bool(false), position: f32(0) });
    // Forward the actual write status. Launch only after the required history exists.
    const grain = grains.tick({ written: written.written, reset, trigger: beat.tick.and(written.length.gt(2048)),
      ageFrames: f32(2048), rate: rate.at(i), durationSeconds: f32(0.08) });
    output.ch(0).at(i).write(grain.output);
  }); } };
});
