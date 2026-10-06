import { audioOutput, defineProcessor, f32, forSample, i32, instantiate, param, select, state } from '@unworklet/core';
import { spectralBlur, spectralCrossSynthesis } from '@denaudio/den/spectral-texture';

export default defineProcessor(() => {
  const blur = instantiate(spectralBlur, { size: 64, hopSize: 32, radius: 2 }, { name: 'blur' });
  const cross = instantiate(spectralCrossSynthesis, { size: 64, hopSize: 32, maxGain: 4 }, { name: 'cross' });
  // The 17-sample source and 32-sample framing repeat together after 544 samples.
  // This native counter gives the observer a phase, not a fitted audio alignment.
  const frame = state.i32(0).named('frame');
  const inverted = state.bool(false).named('inverted');
  const previousFlip = state.bool(false).named('previousFlip');
  const amount = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('amount');
  const carrierLevel = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('carrierLevel');
  const modulatorLevel = param.f32({ default: 1, min: 0, max: 1, automationRate: 'a-rate' }).named('modulatorLevel');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const flip = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('flip');
  const samePattern = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('samePattern');
  const output = audioOutput({ name: 'main', channels: 12 });
  return { process() { forSample((i, everyNSamples) => {
    const controls = [amount.at(i), carrierLevel.at(i), modulatorLevel.at(i), reset.at(i), flip.at(i), samePattern.at(i)];
    const clear = controls[3].gte(.5), request = controls[4].gte(.5);
    inverted.write(select(clear, false, select(request.and(previousFlip.read().not()), inverted.read().not(), inverted.read())));
    previousFlip.write(select(clear, false, request));
    const n = frame.read();
    const a = f32(n.mod(17).mul(5).mod(17).sub(8)).div(32);
    const b = f32(n.mod(17).mul(7).mod(17).sub(8)).div(32);
    const carrier = a.mul(controls[1]).mul(select(inverted.read(), f32(-1), f32(1)));
    const modulator = select(controls[5].gte(.5), a, b).mul(controls[2]);
    const blurred = blur.tick(carrier, controls[0], clear, everyNSamples);
    const crossed = cross.tick(carrier, modulator, controls[0], clear, everyNSamples);
    [blurred, crossed, carrier, modulator, f32(n), f32(inverted.read()), ...controls]
      .forEach((value, channel) => output.ch(channel).at(i).write(value));
    frame.write(n.add(1).mod(544));
  }); } };
}, { id: 'den.spectral-texture.browser' });
