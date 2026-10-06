import { audioInput, audioOutput, bool, defineProcessor, forSample, instantiate, param } from '@unworklet/core';
import { stftIdentity } from '@denaudio/den/spectral';

export default defineProcessor(() => {
  const input = audioInput({ name: 'main', channels: 1 });
  const output = audioOutput({ name: 'main', channels: 1 });
  const gain = param.f32({ default: 0.8, min: 0, max: 1, automationRate: 'a-rate' }).named('gain');
  // FFT -> IFFT with sqrt-Hann overlap-add. Identity has 256-sample latency.
  // This is the actual spectral reconstruction, with no parallel dry bypass.
  const identity = instantiate(stftIdentity, { size: 256, hopSize: 64 }, { name: 'stft' });
  return { process() { forSample((i, everyNSamples) => {
    output.ch(0).at(i).write(identity.tick(input.ch(0).at(i), bool(false), everyNSamples).mul(gain.at(i)));
  }); } };
});
