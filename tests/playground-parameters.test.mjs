import test from 'node:test';
import assert from 'node:assert/strict';
import { sliderBounds, scheduleParameter } from '../playground/src/parameter-range.ts';
test('parameter sliders preserve declared finite ranges without imposing units or quantization', () => {
  for (const [min, max] of [[0, 1], [40, 8000], [-2, 2], [.001, .1], [1e-20, 2e-20]]) assert.deepEqual(sliderBounds(min, max), { min, max });
});
test('parameter sliders do not invent ranges for unbounded, degenerate or unsafe values', () => {
  for (const [min, max] of [[0, 0], [1, 0], [-Infinity, Infinity], [0, NaN], [-3.4028234663852886e38, 3.4028234663852886e38], [0, 1e20], [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) assert.equal(sliderBounds(min, max), null);
});

test('parameter UI sync uses the native scheduled value, not a stale AudioParam getter', () => {
  const calls = [];
  const parameter = { minValue: 40, maxValue: 8000, get value() { throw new Error('value is a stale render-quantum observation'); }, setValueAtTime(value, time) { calls.push({ value, time }); } };
  assert.equal(scheduleParameter(parameter, 250, 1.25), 250);
  assert.equal(scheduleParameter(parameter, 9000, 1.5), 8000);
  assert.equal(scheduleParameter(parameter, 0, 1.75), 40);
  assert.equal(scheduleParameter(parameter, 333.333, 2), Math.fround(333.333));
  assert.deepEqual(calls, [{ value: 250, time: 1.25 }, { value: 8000, time: 1.5 }, { value: 40, time: 1.75 }, { value: Math.fround(333.333), time: 2 }]);
});
