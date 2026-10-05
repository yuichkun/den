import { audioOutput, bool, CAPACITY_16, defineProcessor, event, f32, forSample, instantiate, param } from '@unworklet/core';
import { granularSource, residentSample, samplePlayer } from '@denaudio/den/sample';
import { stftIdentity } from '@denaudio/den/spectral';
import { partitionedConvolution } from '@denaudio/den/convolution';

// Deliberately small functional graph. Maximum-capacity cost has separate evidence.
export default defineProcessor(({ sampleRate }) => {
  const sample = instantiate(residentSample, { capacity: 256, sourceSampleRate: sampleRate }, { name: 'sample' });
  const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: 1024 });
  load.onReceive(({ data }) => sample.load(data));
  const gate = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('gate');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const player = instantiate(samplePlayer, { sampleRate, sample, loop: true }, { name: 'player' });
  const grains = instantiate(granularSource, { sampleRate, sample, maxGrains: 2, seed: 174 }, { name: 'grains' });
  const stft = instantiate(stftIdentity, { size: 8, hopSize: 4 }, { name: 'identity' });
  const convolution = instantiate(partitionedConvolution, { blockSize: 4, impulse: [.5, -.25, .25] }, { name: 'convolution' });
  const out = audioOutput({ name: 'main', channels: 7 });
  return { process() { forSample((i, everyNSamples) => {
    const on = gate.at(i).gte(.5), clear = reset.at(i).gte(.5);
    const play = player.tick({ gate: on, trigger: bool(false), reset: clear, rate: f32(1) });
    const g = grains.tick({ gate: on, reset: clear, positionFrames: f32(0), jitterFrames: f32(0), rate: f32(1), durationSeconds: f32(.04), densityHz: f32(200) });
    [play.output, stft.tick(play.output, clear, everyNSamples), convolution.tick(play.output, clear, everyNSamples), g.output, f32(sample.length()), f32(g.activeGrains), play.position].forEach((x, ch) => out.ch(ch).at(i).write(x));
  }); } };
});
