import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { lookaheadLimiter } from '@denaudio/den/lookahead-limiter';

export default defineProcessor(({ sampleRate }) => {
  const input = audioInput({ name: 'main', channels: 2 });
  const output = audioOutput({ name: 'main', channels: 2 });
  const ceilingDb = param.f32({ default: -26, min: -40, max: -6, automationRate: 'a-rate' }).named('ceilingDb');
  const release = param.f32({ default: 0.08, min: 0.005, max: 0.5, automationRate: 'a-rate' }).named('release');
  // Fixed 128-sample latency. This is a sample-peak, not a true-peak limiter.
  const limiter = instantiate(lookaheadLimiter, { sampleRate, lookaheadSamples: 128 }, { name: 'limiter' });
  return { process() { forSample(i => {
    const wet = limiter.tick(input.ch(0).at(i), input.ch(1).at(i), {
      ceilingDb: ceilingDb.at(i), release: release.at(i), reset: bool(false),
    });
    output.ch(0).at(i).write(wet.left);
    output.ch(1).at(i).write(wet.right);
  }); } };
});
