import { audioOutput, defineProcessor, f32, f64, forSample, i32, instantiate, param, select, state } from '@unworklet/core';
import { liveSampleBuffer } from '@denaudio/den/live-buffer';
import { liveGranularSource } from '@denaudio/den/live-granular';
export default defineProcessor(({ sampleRate }) => {
  const history = instantiate(liveSampleBuffer, { capacity: 64, sampleRate }, { name: 'history' });
  const grains = instantiate(liveGranularSource, { history, maxGrains: 1 }, { name: 'grains' });
  const count = state.i32(0).named('acceptedCount'), frame = state.i32(0).named('frame');
  const requests = state.i32(0).named('requests'), launchAt = state.i32(0).named('launchAt');
  const totals = ['launched', 'dropped', 'rejected', 'expired'].map(name => state.i32(0).named(name));
  const record = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('record');
  const reset = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('reset');
  const trigger = param.f32({ default: 0, min: 0, max: 1, automationRate: 'a-rate' }).named('trigger');
  const age = param.f32({ default: 4, min: 0, max: 64, automationRate: 'a-rate' }).named('age');
  const rate = param.f32({ default: 0, min: -16, max: 16, automationRate: 'a-rate' }).named('rate');
  const duration = param.f32({ default: 2, min: 0, max: 2, automationRate: 'a-rate' }).named('duration');
  const limit = param.f32({ default: 32, min: 0, max: 128, automationRate: 'a-rate' }).named('limit');
  const base = param.f32({ default: .25, min: -1, max: 1, automationRate: 'a-rate' }).named('base');
  const burst = param.f32({ default: 3, min: 1, max: 4, automationRate: 'a-rate' }).named('burst');
  const output = audioOutput({ name: 'main', channels: 20 });
  return { process() { forSample(i => {
    const controls = [record.at(i), reset.at(i), trigger.at(i), age.at(i), rate.at(i), duration.at(i), limit.at(i), base.at(i), burst.at(i)];
    const clear = controls[1].gt(0), now = select(clear, i32(0), frame.read()), writtenCount = count.read();
    const writing = controls[0].gt(0).and(writtenCount.lt(i32(controls[6])));
    const status = history.tick({ input: controls[7].add(f32(writtenCount).div(64)), record: writing, reset: clear });
    count.write(select(clear, i32(0), writtenCount.add(select(status.written, i32(1), i32(0)))));
    const request = controls[2].gt(0).and(requests.read().lt(i32(controls[8]))).and(clear.not());
    const r = grains.tick({ written: status.written, reset: clear, trigger: request, ageFrames: controls[3], rate: controls[4], durationSeconds: controls[5] });
    requests.write(select(clear.or(controls[2].lte(0)), i32(0), requests.read().add(select(request, i32(1), i32(0)))));
    launchAt.write(select(clear, i32(0), select(r.launched, now, launchAt.read())));
    [i32(r.launched), i32(r.dropped), i32(r.rejected), r.expiredGrains].forEach((value, n) => totals[n].write(select(clear, i32(0), totals[n].read().add(value))));
    const anchor = history.readAge(f64(4));
    [r.output, f32(r.activeGrains), ...totals.map(s => f32(s.read())), f32(now.sub(launchAt.read())), anchor.output, f32(anchor.available), f32(status.length), f32(count.read()), ...controls]
      .forEach((value, channel) => output.ch(channel).at(i).write(value));
    frame.write(select(clear, i32(0), now.add(1)));
  }); } };
}, { id: 'den.live-granular.browser' });
