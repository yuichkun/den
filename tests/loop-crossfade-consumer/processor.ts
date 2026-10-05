import { audioOutput, bool, CAPACITY_16, defineProcessor, event, f32, forSample, instantiate, select, state } from '@unworklet/core';
import { residentSample, type ResidentSample, type SamplePlayerControls } from '@denaudio/den/sample';
import { crossfadedLoopPlayer, type CrossfadedLoopConfig } from '@denaudio/den/loop-crossfade';
export const pcm = Float32Array.from({ length: 1024 }, (_, n) => .6 * Math.sin(2 * Math.PI * n / 61) + .25 * n / 1023);
export const sourceRate = 32000;
export const makeProcessor = () => defineProcessor(ctx => {
  const sample: ResidentSample = instantiate(residentSample, { capacity: 1024, sourceSampleRate: sourceRate }, { name: 'sample' });
  const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: 4096 }); load.onReceive(x => sample.load(x.data));
  const config: CrossfadedLoopConfig = { sampleRate: ctx.sampleRate, sample, startFrame: 3, endFrame: 997, crossfadeFrames: 127, releaseFrames: 31 };
  const forward = instantiate(crossfadedLoopPlayer, config, { name: 'forward' });
  const reverse = instantiate(crossfadedLoopPlayer, config, { name: 'reverse' });
  const frame = state.i32(0).named('frame'), output = audioOutput({ channels: 8, name: 'main' });
  return { process() { forSample(i => {
    const n = frame.read(), gate = n.lt(3500), reset = n.gte(2040).and(n.lt(2043)), trigger = n.eq(2500);
    const c: SamplePlayerControls = { gate, reset, trigger, rate: select(n.lt(1536), f32(.75), f32(-.625)) };
    const a = forward.tick(c), b = reverse.tick({ ...c, rate: f32(-1.25) });
    [a.output, b.output, a.phase, a.position, f32(a.periodFrames), f32(a.crossfadeFrames), f32(a.active), f32(a.missing)].forEach((value, ch) => output.ch(ch).at(i).write(value));
    frame.write(n.add(1));
  }); } };
});
