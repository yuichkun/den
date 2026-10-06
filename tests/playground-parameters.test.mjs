import test from 'node:test';
import assert from 'node:assert/strict';
import { sliderBounds } from '../playground/src/parameter-range.ts';
test('parameter sliders preserve declared finite ranges without imposing units or quantization', () => {
  for (const [min, max] of [[0, 1], [40, 8000], [-2, 2], [.001, .1], [1e-20, 2e-20]]) assert.deepEqual(sliderBounds(min, max), { min, max });
});
test('parameter sliders do not invent ranges for unbounded, degenerate or unsafe values', () => {
  for (const [min, max] of [[0, 0], [1, 0], [-Infinity, Infinity], [0, NaN], [-3.4028234663852886e38, 3.4028234663852886e38], [0, 1e20], [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) assert.equal(sliderBounds(min, max), null);
});
