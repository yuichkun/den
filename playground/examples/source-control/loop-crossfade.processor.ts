import { audioOutput, bool, CAPACITY_16, defineProcessor, event, forSample, instantiate, param } from '@unworklet/core';
import { residentSample } from '@denaudio/den/sample';
import { crossfadedLoopPlayer } from '@denaudio/den/loop-crossfade';

// Deliberately non-periodic slice: the loop's overlap blends its seam.
const data = Float32Array.from({ length: 4096 }, (_, frame) =>
  0.14 * Math.sin(2 * Math.PI * frame / 217) + 0.035 * Math.sin(2 * Math.PI * frame / 83));
export const initial = { gate: 0 };
export const events = [{ name: 'load', payload: { data } }];
export const ready = [{ suffix: 'sample/length', value: data.length }];
export const afterReady = { gate: 1 };

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const sample = instantiate(residentSample, { capacity: data.length, sourceSampleRate: 48000 }, { name: 'sample' });
  event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: data.byteLength })
    .onReceive(packet => sample.load(packet.data));
  const loop = instantiate(crossfadedLoopPlayer, { sampleRate, sample, crossfadeFrames: 256, releaseFrames: 240 }, { name: 'loop' });
  const gate = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('gate');
  const rate = param.f32({ default: 1, min: -2, max: 2, automationRate: 'a-rate' }).named('rate');
  return { process() { forSample(i => {
    output.ch(0).at(i).write(loop.tick({ gate: gate.at(i).gte(0.5), trigger: bool(false), reset: bool(false), rate: rate.at(i) }).output);
  }); } };
});
