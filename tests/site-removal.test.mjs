import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSite } from '../scripts/build-site.mjs';

test('public builder replaces all former routes with only the isolated playground output', () => {
  const output = mkdtempSync(join(tmpdir(), 'den-public-removal-'));
  const built = mkdtempSync(join(tmpdir(), 'den-public-playground-'));
  mkdirSync(join(output, 'assets'));
  for (const file of ['index.html', 'catalog.html', 'audition.html', 'diagnostics.html', 'playground.html', 'catalog-home.js', 'site.css', 'assets/old.js', 'assets/old.wasm']) writeFileSync(join(output, file), 'old public UI');
  writeFileSync(join(built, 'index.html'), '<main>New packed playground</main>');
  const calls = [];
  const build = options => { calls.push(options); return { output: built }; };
  assert.equal(buildSite({ output, build }).output, output);
  assert.deepEqual(calls, [{ fixture: 'playground', stageSite: false }]);
  assert.deepEqual(readdirSync(output), ['index.html']);
  assert.match(readFileSync(join(output, 'index.html'), 'utf8'), /New packed playground/);
  buildSite({ output, build });
  assert.deepEqual(readdirSync(output), ['index.html']);
});
