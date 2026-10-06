import { audioInput, audioOutput, bool, CAPACITY_16, defineProcessor, event, forSample, instantiate, param } from '@unworklet/core';
import { preparedConvolution, prepareConvolutionSpectrum, type PreparedConvolutionPacket } from '@denaudio/den/prepared-convolution';

// Host preparation: a 4096-frame IR, no network fetch and no callback-side FFT preparation.
const config = { blockSize: 128, partitions: 64 };
const impulse = Array.from({ length: 4096 }, (_, n) => n === 0 ? 0.6 : n === 2400 ? 0.25 : n === 4000 ? -0.12 : 0);
export const events = [{ name: 'ir', payload: prepareConvolutionSpectrum(impulse, config) }];
// The host emits the unchanged packet while muted, then checks native state.
export const ready = [{ suffix: 'convolution/loaded', value: true }, { suffix: 'convolution/rejected', value: false }];

export default defineProcessor(() => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const gain = param.f32({ default: 0.8, min: 0, max: 1.5, automationRate: 'a-rate' }).named('gain');
  const convolution = instantiate(preparedConvolution, config, { name: 'convolution' });
  event<PreparedConvolutionPacket>({ from: 'main', name: 'ir', capacity: CAPACITY_16, payloadCapacity: 131072 })
    .onReceive(packet => convolution.load(packet));
  return { process() { forSample((i, everyNSamples) => {
    const wet = convolution.tick(input.ch(0).at(i), bool(false), everyNSamples);
    output.ch(0).at(i).write(wet.output.mul(gain.at(i)));
  }); } };
});
