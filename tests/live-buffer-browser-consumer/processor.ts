import { audioOutput, defineProcessor, f32, f64, forSample, i32, instantiate, param, select, state } from '@unworklet/core';
import { liveSampleBuffer } from '@denaudio/den/live-buffer';

export default defineProcessor(({ sampleRate }) => {
  const history = instantiate(liveSampleBuffer, { capacity: 8, sampleRate }, { name: 'history' });
  const count = state.i32(0).named('acceptedCount');
  const sumBefore = state.f64(0).named('sumBefore'), sumAfter = state.f64(0).named('sumAfter');
  const record = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('record');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const age = param.f32({ default: 0, min: -1, max: 9, automationRate: 'a-rate' }).named('age');
  const limit = param.f32({ default: 3, min: 0, max: 32, automationRate: 'a-rate' }).named('limit');
  const base = param.f32({ default: .25, min: -1, max: 1, automationRate: 'a-rate' }).named('base');
  const output = audioOutput({ name: 'main', channels: 18 });
  return { process() { forSample(i => {
    const controls = [record.at(i), reset.at(i), age.at(i), limit.at(i), base.at(i)];
    const clear = controls[1].gt(0), n = count.read();
    const before = history.readAge(f64(controls[2]));
    const status = history.tick({ input: controls[4].add(f32(n).div(16)), record: controls[0].gt(0).and(n.lt(i32(controls[3]))), reset: clear });
    const after = history.readAge(f64(controls[2]));
    count.write(select(clear, i32(0), n.add(select(status.written, i32(1), i32(0)))));
    sumBefore.write(select(clear, f64(0), sumBefore.read().add(select(status.written, f64(before.output), f64(0)))));
    sumAfter.write(select(clear, f64(0), sumAfter.read().add(select(status.written, f64(after.output), f64(0)))));
    [before.output, after.output, f32(after.available), f32(status.length), f32(status.full), f32(status.written), f32(count.read()), f32(history.revision()), history.readAge(f64(0)).output, history.readAge(f64(7)).output, ...controls, f32(sumBefore.read()), f32(sumAfter.read()), f32(before.available)]
      .forEach((value, channel) => output.ch(channel).at(i).write(value));
  }); } };
}, { id: 'den.live-buffer.browser' });
