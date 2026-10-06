import { audioOutput, bool, CAPACITY_16, defineProcessor, event, forSample, instantiate, param } from '@unworklet/core';
import { residentSample, samplePlayer } from '@denaudio/den/sample';

// Host-side PCM is visible and self-contained. No file or microphone is needed.
const sourceSampleRate = 48000;
const data = Float32Array.from({ length: 4096 }, (_, frame) =>
  0.12 * Math.sin(2 * Math.PI * frame / 256) + 0.045 * Math.sin(2 * Math.PI * frame / 128));
export const initial = { gate: 0 };
export const events = [{ name: 'load', payload: { data } }];
export const ready = [{ suffix: 'sample/length', value: data.length }];
export const afterReady = { gate: 1 };

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const sample = instantiate(residentSample, { capacity: data.length, sourceSampleRate }, { name: 'sample' });
  event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: data.byteLength })
    .onReceive(packet => sample.load(packet.data));
  const player = instantiate(samplePlayer, { sampleRate, sample, loop: true, releaseFrames: 240 }, { name: 'player' });
  const gate = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('gate');
  const rate = param.f32({ default: 1, min: -2, max: 2, automationRate: 'a-rate' }).named('rate');
  return { process() { forSample(i => {
    const result = player.tick({ gate: gate.at(i).gte(0.5), trigger: bool(false), reset: bool(false), rate: rate.at(i) });
    output.ch(0).at(i).write(result.output);
  }); } };
});
