import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSite } from '../scripts/build-site.mjs';

test('public build deletes every former page and asset before writing the minimal root', () => {
  const output = mkdtempSync(join(tmpdir(), 'den-public-removal-'));
  mkdirSync(join(output, 'assets'));
  for (const file of ['index.html', 'catalog.html', 'audition.html', 'diagnostics.html', 'playground.html', 'catalog-home.js', 'site.css', 'assets/old.js', 'assets/old.wasm']) writeFileSync(join(output, file), 'old public UI');
  assert.equal(buildSite({ output }).output, output);
  assert.deepEqual(readdirSync(output), ['index.html']);
  const html = readFileSync(join(output, 'index.html'), 'utf8');
  assert.match(html, /Rebuilding the playground/);
  assert.doesNotMatch(html, /<(?:script|link|style|a|button|input|select|audio|video|canvas|img)\b/i);
  buildSite({ output });
  assert.deepEqual(readdirSync(output), ['index.html']);
});
