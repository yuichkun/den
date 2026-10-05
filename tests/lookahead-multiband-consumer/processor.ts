import { audioInput, audioOutput, defineProcessor, f32, forSample, instantiate } from '@unworklet/core';
import { lookaheadLimiter } from '@denaudio/den/lookahead-limiter';
import { multibandDynamics, type MultibandDynamicsBandConfig } from '@denaudio/den/multiband-dynamics';

export function makeLimiter(rate: number, lookaheadSamples: number) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 5, name: 'main' }), output = audioOutput({ channels: 8, name: 'main' });
    const unit = instantiate(lookaheadLimiter, { sampleRate: rate, lookaheadSamples }, { name: 'limiter' });
    return { process() { forSample(i => {
      const c = (ch: number) => input.ch(ch).at(i);
      const y = unit.tick(c(0), c(1), { ceilingDb: c(2), release: c(3), reset: c(4).gt(0) });
      [y.left,y.right,y.dryLeft,y.dryRight,y.envelope,y.windowPeak,y.gain,y.ceiling].forEach((x,ch)=>output.ch(ch).at(i).write(x));
    }); } };
  });
}
const defaults: readonly [MultibandDynamicsBandConfig,MultibandDynamicsBandConfig,MultibandDynamicsBandConfig] = [
  {mode:'peak',operation:'compressor'}, {mode:'peak',operation:'compressor'}, {mode:'peak',operation:'compressor'},
];
export function makeMultiband(rate: number, bands = defaults, controlOffsets = false) {
  return defineProcessor(() => {
    // Program L/R, cutoffs, ratio, threshold, attack, release, reset.
    // Independent bands process their own filtered stereo sidechains.
    const input = audioInput({ channels: 9, name: 'main' }), output = audioOutput({ channels: 17, name: 'main' });
    const unit = instantiate(multibandDynamics, { sampleRate: rate, bands }, { name: 'multiband' });
    return { process() { forSample(i => {
      const c = (ch: number) => input.ch(ch).at(i);
      const settings = [0,1,2].map(band => ({ thresholdDb:controlOffsets?c(5).sub(band*6):c(5),ratio:controlOffsets?c(4).add(band*2):c(4),kneeDb:f32(0),rangeDb:f32(60),
        detectorAttack:f32(0),detectorRelease:f32(0),attack:c(6),release:c(7) }));
      const y = unit.tick(c(0), c(1), { lowCutoffHz:c(2), highCutoffHz:c(3), bands:[settings[0],settings[1],settings[2]],reset:c(8).gt(0) });
      [y.left,y.right,y.dryLeft,y.dryRight,y.low.left,y.mid.left,y.high.left,y.low.right,y.mid.right,y.high.right,
        y.low.gain,y.mid.gain,y.high.gain,y.low.envelope,y.mid.envelope,y.high.envelope,y.lowCutoffHz].forEach((x,ch)=>output.ch(ch).at(i).write(x));
    }); } };
  });
}
