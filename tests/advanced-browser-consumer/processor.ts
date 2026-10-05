import { audioOutput, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { oscillator } from '@denaudio/den/oscillator';
import { frequencyShifter } from '@denaudio/den/frequency-shifter';
import { lookaheadLimiter } from '@denaudio/den/lookahead-limiter';
import { curveShaper } from '@denaudio/den/curve-shaper';
import { multibandDynamics } from '@denaudio/den/multiband-dynamics';
export default defineProcessor(({ sampleRate }) => {
  const curve = instantiate(curveShaper, { sampleRate, pointCount: 3, quality: 'adaa' }, { name: 'curve' });
  const ordinate = param.f32({ default: 0, min: -1, max: 1, automationRate: 'a-rate' }).named('ordinate');
  const source = instantiate(oscillator, { sampleRate, waveform: 'sine' }, { name: 'source' });
  const shifter = instantiate(frequencyShifter, { sampleRate }, { name: 'shifter' });
  const limiter = instantiate(lookaheadLimiter, { sampleRate, lookaheadSamples: 16 }, { name: 'limiter' });
  const multiband = instantiate(multibandDynamics, { sampleRate, bands: [{ mode: 'peak', operation: 'compressor' }, { mode: 'peak', operation: 'compressor' }, { mode: 'peak', operation: 'compressor' }] }, { name: 'multiband' });
  const shift = param.f32({ default: 750, min: -12000, max: 12000, automationRate: 'a-rate' }).named('shift');
  const ceiling = param.f32({ default: -6, min: -120, max: 0, automationRate: 'a-rate' }).named('ceiling');
  const ratio = param.f32({ default: 1, min: 1, max: 100, automationRate: 'a-rate' }).named('ratio');
  const bypass = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('bypass');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const out = audioOutput({ name: 'main', channels: 9 });
  return { process() { forSample(i => {
    const clear = reset.at(i).gte(.5), x = source.tick(f32(6000), clear).mul(.125);
    const shifted = shifter.tick(x, { shiftHz: shift.at(i), mix: f32(1), bypass: bypass.at(i).gte(.5), reset: clear });
    const limited = limiter.tick(f32(.8), f32(-.4), { ceilingDb: ceiling.at(i), release: f32(0), reset: clear });
    const band = { thresholdDb: f32(-120), ratio: ratio.at(i), kneeDb: f32(0), rangeDb: f32(120), attack: f32(0), release: f32(0), detectorAttack: f32(0), detectorRelease: f32(0) };
    const split = multiband.tick(x, x.mul(-.5), { lowCutoffHz: f32(1000), highCutoffHz: f32(4000), bands: [band, band, band], reset: clear });
    [x, shifted, limited.left, limited.right, limited.ceiling, split.left, split.right, split.dryLeft, curve.tick(x, { ordinates: [f32(-1), ordinate.at(i), f32(1)], gain: f32(1), mix: f32(1), reset: clear })].forEach((v, ch) => out.ch(ch).at(i).write(v));
  }); } };
});
