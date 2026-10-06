import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { renderOffline } from '@unworklet/offline';
import processor from './processor.ts';
const stages = [
  [0,0,0,3,.25], [1,0,0,3,.25], [0,0,.5,3,.25], [0,0,3,3,.25],
  [1,0,0,20,.25], [0,0,.5,20,.25], [1,1,.5,4,-.5], [1,0,.5,4,-.5],
  [0,0,.5,20,.25], [0,0,7,20,.25], [1,1,0,2,.25], [1,0,0,2,.25],
];
const frames = stages.length * 128, names = ['record', 'reset', 'age', 'limit', 'base'];
const values = n => stages[Math.floor(n / 128)];
const params = Object.fromEntries(names.map((name, i) => [name, Array.from({ length: frames }, (_, n) => values(n)[i])]));
let history = [], count = 0, revision = 0, sumBefore = 0, sumAfter = 0;
const expected = Array.from({ length: 18 }, () => new Float32Array(frames));
const read = age => {
  const available = Number.isFinite(age) && age >= 0 && age <= history.length - 1;
  if (!available) return [0, 0];
  const lo = Math.floor(age), fraction = age - lo;
  const a = history[history.length - 1 - lo], b = history[Math.max(0, history.length - 2 - lo)];
  return [Math.fround(a + (b - a) * fraction), 1];
};
for (let n = 0; n < frames; n++) {
  const [record, reset, age, limit, base] = values(n), before = read(age), written = record > 0 && count < limit && !reset;
  if (reset) { history = []; count = 0; revision++; }
  else if (written) { history.push(Math.fround(base + count / 16)); if (history.length > 8) history.shift(); count++; revision++; }
  const after = read(age);
  if (reset) { sumBefore = 0; sumAfter = 0; } else if (written) { sumBefore += before[0]; sumAfter += after[0]; }
  const row = [before[0], after[0], after[1], history.length, +(history.length === 8), +written, count, revision, read(0)[0], read(7)[0], record, reset, age, limit, base, sumBefore, sumAfter, before[1]];
  row.forEach((v, ch) => expected[ch][n] = v);
}
const reports = [];
for (const sampleRate of [44100, 48000, 96000]) {
  const run = (start, end, restore) => renderOffline(processor, { sampleRate, duration: (end - start - .25) / sampleRate, params: Object.fromEntries(names.map(name => [name, params[name].slice(start, end)])), ...(restore ? { restore } : {}) });
  const actual = await run(0, frames); assert.equal(actual.diagnostics.scrubbedSamples, 0); assert.deepEqual(actual.outputs.main, expected);
  for (const split of [128, 256, 640, 768, 1152]) {
    const a = await run(0, split), b = await run(split, frames, a.state);
    assert.deepEqual(b.outputs.main, expected.map(x => x.slice(split))); assert.deepEqual(b.state, actual.state); assert.equal(b.diagnostics.scrubbedSamples, 0);
  }
  reports.push({ sampleRate, frames, channels: 18, exact: true, snapshots: [128,256,640,768,1152], scrubbedSamples: 0 });
}
writeFileSync('native-composition.json', JSON.stringify(reports, null, 2)); console.log(JSON.stringify(reports));
