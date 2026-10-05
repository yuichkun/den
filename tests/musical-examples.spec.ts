import { test } from 'vitest';
import * as examples from '../src/musical-examples.js';
import { checkMaterials, checkExample, fixture, checkResetAndAssets } from './musical-examples-consumer/checks.mjs';
test('musical materials are complete original deterministic candidates with distinct A/B controls', () => checkMaterials(examples));
for (const name of ['glassDyad', 'fmModalHit', 'grainCloud', 'shapedEcho']) {
  test(`${name}: independent composition oracle, native edits, tail and exact snapshot`, async () => {
    await checkExample(examples, fixture(examples, name, 0, 48000));
  }, 120000);
  test(`${name}: reset, restart and resident lifecycle`, async () => { await checkResetAndAssets(examples, name); }, 120000);
}
