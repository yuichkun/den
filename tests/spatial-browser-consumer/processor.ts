import { audioOutput, defineProcessor, f32, forSample, i32, instantiate, param, select, state } from '@unworklet/core';
import { oscillator } from '@denaudio/den/oscillator';
import { hybridReverb, feedforwardPitchedReverb } from '@denaudio/den/spatial-chains';

export default defineProcessor(({ sampleRate }) => {
  const source = instantiate(oscillator, { sampleRate, waveform: 'sine' }, { name: 'source' });
  const hybrid = instantiate(hybridReverb, { sampleRate }, { name: 'hybrid' });
  const pitched = instantiate(feedforwardPitchedReverb, { sampleRate, windowSamples: 2048 }, { name: 'pitched' });
  const twin = instantiate(feedforwardPitchedReverb, { sampleRate, windowSamples: 2048 }, { name: 'twin' });
  const frame = state.i32(0).named('frame');
  const level = param.f32({ default: .25, min: 0, max: .5, automationRate: 'a-rate' }).named('level');
  const mix = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('mix');
  const bypass = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('bypass');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const ratio = param.f32({ default: 1, min: .5, max: 2, automationRate: 'a-rate' }).named('ratio');
  const pitchMix = param.f32({ default: .5, min: 0, max: 1, automationRate: 'a-rate' }).named('pitchMix');
  const retrigger = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('retrigger');
  const disturb = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('disturb');
  const output = audioOutput({ name: 'main', channels: 19 });
  return { process() { forSample((i, everyNSamples) => {
    const values = [level.at(i), mix.at(i), bypass.at(i), reset.at(i), ratio.at(i), pitchMix.at(i), retrigger.at(i), disturb.at(i)];
    const clear = values[3].gte(.5), now = select(clear, i32(0), frame.read());
    const input = source.tick(f32(sampleRate / 128), clear).mul(values[0]);
    const controls = { mix: values[1], bypass: values[2].gte(.5), reset: clear, ratio: values[4], pitchMix: values[5], retrigger: values[6].gte(.5) };
    const h = hybrid.tick(input, controls, everyNSamples);
    const p = pitched.tick(input, controls, everyNSamples);
    const q = twin.tick(input.add(values[7].mul(.5)), controls, everyNSamples);
    [h.left, h.right, p.left, p.right, q.left, q.right, input, f32(now), p.left.sub(q.left), p.right.sub(q.right), f32(p.ratioRejected), ...values]
      .forEach((value, channel) => output.ch(channel).at(i).write(value));
    // The oscillator also emits phase zero then advances on a reset sample.
    frame.write(now.add(1).mod(256));
  }); } };
}, { id: 'den.spatial.browser' });
