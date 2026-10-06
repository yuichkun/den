import { audioOutput, bool, CAPACITY_16, defineProcessor, event, forSample, i32, instantiate, param, select, state } from '@unworklet/core';
import { residentSample } from '@denaudio/den/sample';
import { residentTimeStretch } from '@denaudio/den/resident-time-stretch';

// Prepare one second of quiet, changing harmonic PCM on the host.
const sourceSampleRate = 48000;
const data = Float32Array.from({ length: 48000 }, (_, frame) => {
  const t = frame / sourceSampleRate;
  const envelope = Math.sin(Math.PI * t) ** 2;
  return envelope * (0.12 * Math.sin(2 * Math.PI * (220 * t + 55 * t * t)) + 0.05 * Math.sin(2 * Math.PI * 440 * t));
});
export const initial = { gate: 0 };
export const events = [{ name: 'load', payload: { data } }];
export const ready = [{ suffix: 'sample/length', value: data.length }];
export const afterReady = { gate: 1 };

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const sample = instantiate(residentSample, { capacity: data.length, sourceSampleRate }, { name: 'sample' });
  event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: data.byteLength })
    .onReceive(packet => sample.load(packet.data));
  const stretch = instantiate(residentTimeStretch, { sampleRate, sample, hopSamples: 128, searchFrames: 8 }, { name: 'stretch' });
  const gate = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('gate');
  const durationScale = param.f32({ default: 1.5, min: 0.5, max: 2, automationRate: 'a-rate' }).named('durationScale');
  const pitchRatio = param.f32({ default: 1, min: 0.5, max: 2, automationRate: 'a-rate' }).named('pitchRatio');
  const clock = state.i32(0).named('repeatClock');
  const repeatFrames = Math.round(sampleRate * 2.5);
  return { process() { forSample((i, everyNSamples) => {
    const open = gate.at(i).gte(0.5);
    // A one-sample request repeats the asset every 2.5 seconds. Each launch
    // latches duration and pitch independently; a held trigger would keep restarting.
    const trigger = open.and(clock.read().eq(0));
    clock.write(select(open, clock.read().add(1).mod(repeatFrames), i32(0)));
    const wet = stretch.tick({ gate: open, trigger, reset: bool(false), durationScale: durationScale.at(i), pitchRatio: pitchRatio.at(i) }, everyNSamples);
    output.ch(0).at(i).write(wet.output);
  }); } };
});
