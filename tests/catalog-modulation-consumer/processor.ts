import { audioInput, audioOutput, defineProcessor, forSample, instantiate, f32 } from '@unworklet/core';
import { flanger, phaser, type FlangerControls, type PhaserControls } from '@denaudio/den/modulation-fx';
import { multiTapDelay, pingPongDelay, type DelayMixControls } from '@denaudio/den/stereo-delay';
import { algorithmicReverb, type ReverbControls } from '@denaudio/den/reverb';
export const processor = defineProcessor(ctx => {
  const input = audioInput({ channels: 1, name: 'main' }), output = audioOutput({ channels: 9, name: 'main' });
  const flange = instantiate(flanger, { sampleRate: ctx.sampleRate, maxDelaySeconds: 32 / ctx.sampleRate }, { name: 'flanger' });
  const phase = instantiate(phaser, { sampleRate: ctx.sampleRate, stages: 4 }, { name: 'phaser' });
  const ping = instantiate(pingPongDelay, { sampleRate: ctx.sampleRate, maxDelaySeconds: 32 / ctx.sampleRate }, { name: 'pingpong' });
  const multi = instantiate(multiTapDelay, { sampleRate: ctx.sampleRate, maxDelaySeconds: 32 / ctx.sampleRate, taps: [
    { delaySeconds: 4 / ctx.sampleRate, gainLeft: 1, gainRight: -1 },
    { delaySeconds: 12 / ctx.sampleRate, gainLeft: 1, gainRight: 1 },
  ] }, { name: 'multitap' });
  const reverb = instantiate(algorithmicReverb, { sampleRate: ctx.sampleRate, decaySeconds: 0.3, dampingHz: 2000 }, { name: 'reverb' });
  return { process() { forSample(i => {
    const x = input.ch(0).at(i), bypass = i.lt(0), reset = i.lt(0);
    const mix: DelayMixControls = { feedback: f32(0.5), mix: f32(1), bypass, reset };
    const flangeControls: FlangerControls = { ...mix, mix: f32(0.5), delaySeconds: f32(8 / ctx.sampleRate), rateHz: f32(0), depthSeconds: f32(0) };
    const phaseControls: PhaserControls = { ...mix, feedback: f32(0), frequencyHz: f32(1200) };
    const reverbControls: ReverbControls = { mix: f32(1), bypass, reset };
    const f = flange.tick(x, x, flangeControls), p = phase.tick(x, phaseControls);
    const d = ping.tick(x, f32(0), { ...mix, timeSeconds: f32(8 / ctx.sampleRate) });
    const m = multi.tick(x, { ...mix, feedback: f32(0) }), r = reverb.tick(x, f32(0), reverbControls);
    [f.left, f.right, p, d.left, d.right, m.left, m.right, r.left, r.right].forEach((v, ch) => output.ch(ch).at(i).write(v));
  }); } };
}, { id: 'den.catalog.modulation.consumer.v1' });
