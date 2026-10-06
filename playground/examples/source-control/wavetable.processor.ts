import { audioOutput, bool, CAPACITY_16, defineProcessor, event, forSample, instantiate, param } from '@unworklet/core';
import { residentSample } from '@denaudio/den/sample';
import { wavetableSource } from '@denaudio/den/wavetable';

const frameLength = 128, frameCount = 2;
// Concatenate a sine cycle and a brighter three-harmonic cycle.
const data = Float32Array.from({ length: frameLength * frameCount }, (_, index) => {
  const phase = 2 * Math.PI * (index % frameLength) / frameLength;
  return Math.sin(phase) * 0.12 + (index >= frameLength ? 0.035 * Math.sin(3 * phase) + 0.015 * Math.sin(5 * phase) : 0);
});
export const events = [{ name: 'load', payload: { data } }];
export const ready = [{ suffix: 'sample/length', value: data.length }];

export default defineProcessor(({ sampleRate }) => {
  const output = audioOutput({ name: 'main', channels: 1 });
  const sample = instantiate(residentSample, { capacity: data.length, sourceSampleRate: 48000 }, { name: 'sample' });
  event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: data.byteLength })
    .onReceive(packet => sample.load(packet.data));
  const wave = instantiate(wavetableSource, { sampleRate, sample, frameLength, frameCount }, { name: 'wave' });
  const frequency = param.f32({ default: 220, min: 40, max: 1000, automationRate: 'a-rate' }).named('frequency');
  const frame = param.f32({ default: 0.7, min: 0, max: 1, automationRate: 'a-rate' }).named('frame');
  return { process() { forSample(i => {
    // Fractional frame positions morph the adjacent cycles. Missing PCM is silent.
    output.ch(0).at(i).write(wave.tick({ frequencyHz: frequency.at(i), frame: frame.at(i), reset: bool(false) }).output);
  }); } };
});
