import { audioOutput, CAPACITY_16, defineProcessor, event, f32, forSample, instantiate, param } from '@unworklet/core';
import { residentSample } from '@denaudio/den/sample';
import { wavetableSource } from '@denaudio/den/wavetable';
import { seededNoise, virtualAnalogSource } from '@denaudio/den/virtual-analog';
export default defineProcessor(({ sampleRate }) => {
  const sample = instantiate(residentSample, { capacity: 64, sourceSampleRate: sampleRate }, { name: 'sample' });
  const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: 256 });
  load.onReceive(({ data }) => sample.load(data));
  const table = instantiate(wavetableSource, { sampleRate, sample, frameLength: 64, frameCount: 1 }, { name: 'table' });
  const pulse = instantiate(virtualAnalogSource, { sampleRate, waveform: 'pulse' }, { name: 'pulse' });
  const triangle = instantiate(virtualAnalogSource, { sampleRate, waveform: 'triangle' }, { name: 'triangle' });
  const noise = instantiate(seededNoise, { seed: 19 }, { name: 'noise' });
  const frequency = param.f32({ default: 750, min: 0, max: 10000, automationRate: 'a-rate' }).named('frequency');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const out = audioOutput({ name: 'main', channels: 5 });
  return { process() { forSample(i => {
    const clear = reset.at(i).gte(.5), c = { frequencyHz: frequency.at(i), duty: f32(.5), reset: clear };
    const t = table.tick({ frequencyHz: c.frequencyHz, frame: f32(0), reset: clear });
    [t.output, f32(t.missing), pulse.tick(c), triangle.tick(c), noise.tick(clear)].forEach((x, ch) => out.ch(ch).at(i).write(x));
  }); } };
});
