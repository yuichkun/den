import { audioInput, audioOutput, CAPACITY_16, defineProcessor, event, f32, forSample, instantiate } from '@unworklet/core';
import { residentSample, type ResidentSample } from '@denaudio/den/sample';
import { wavetableSource, type WavetableControls } from '@denaudio/den/wavetable';
import { seededNoise, virtualAnalogSource, type VirtualAnalogControls } from '@denaudio/den/virtual-analog';
export const frameLength = 4096, frameCount = 16, seed = 2147483646;
export const pcm = Float32Array.from({ length: frameLength * frameCount }, (_, n) => {
  const phase = (n % frameLength) / frameLength, frame = Math.floor(n / frameLength);
  return (frame + 1) / 16 * Math.sin(2 * Math.PI * phase) + .1 * Math.cos(4 * Math.PI * phase);
});
export const makeProcessor = () => defineProcessor(ctx => {
  const sample: ResidentSample = instantiate(residentSample, { capacity: pcm.length, sourceSampleRate: 32000 }, { name: 'sample' });
  const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: pcm.byteLength });
  load.onReceive(({ data }) => sample.load(data));
  const table = instantiate(wavetableSource, { sampleRate: ctx.sampleRate, sample, frameLength, frameCount, phaseCycles: .875 }, { name: 'table' });
  const pulse = instantiate(virtualAnalogSource, { sampleRate: ctx.sampleRate, waveform: 'pulse', phaseCycles: .125 }, { name: 'pulse' });
  const triangle = instantiate(virtualAnalogSource, { sampleRate: ctx.sampleRate, waveform: 'triangle', phaseCycles: .125 }, { name: 'triangle' });
  const noise = instantiate(seededNoise, { seed }, { name: 'noise' });
  const input = audioInput({ channels: 4, name: 'controls' }), output = audioOutput({ channels: 5, name: 'main' });
  return { process() { forSample(i => {
    const reset = input.ch(3).at(i).gt(0), frequencyHz = input.ch(0).at(i);
    const t: WavetableControls = { frequencyHz, frame: input.ch(1).at(i), reset };
    const c: VirtualAnalogControls = { frequencyHz, duty: input.ch(2).at(i), reset };
    const result = table.tick(t);
    output.ch(0).at(i).write(result.output); output.ch(1).at(i).write(f32(result.missing));
    output.ch(2).at(i).write(pulse.tick(c)); output.ch(3).at(i).write(triangle.tick(c)); output.ch(4).at(i).write(noise.tick(reset));
  }); } };
});
