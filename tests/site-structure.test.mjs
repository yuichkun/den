import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageSite } from '../scripts/build-site.mjs';
import { validateCatalog, renderCatalog } from '../site/build-catalog.mjs';
import { modules } from '../site/catalog-data.mjs';
const root = join(import.meta.dirname, '..');
test('catalog metadata has exact public export coverage and real documentation', () => {
  const counts = validateCatalog(root);
  assert.equal(counts.exports, Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).exports).length);
  assert.equal(counts.groups, modules.length);
  const html = renderCatalog(root);
  assert.equal((html.match(/class="module-card"/g) || []).length, modules.length);
  assert.equal((html.match(/class="study-card"/g) || []).length, 4);
  assert.match(html, /CANDIDATE/); assert.match(html, /48 kHz/);
  assert.doesNotMatch(html, /(?:diagnostics|audition)\.html/);
});
test('site staging physically drops old diagnostics and keeps only real listening routes', () => {
  const temp = mkdtempSync(join(tmpdir(), 'den-site-structure-'));
  const fixture = name => {
    const output = join(temp, name); mkdirSync(join(output, 'assets'), { recursive: true });
    writeFileSync(join(output, 'index.html'), '<!doctype html><html><title>Fixture</title><main>Controls</main></html>');
    writeFileSync(join(output, 'assets', `${name}.js`), '// verified consumer placeholder for staging-unit test only');
    return { output, pack: { integrity: 'same-package' } };
  };
  const integration = fixture('integration'), catalog = fixture('catalog'), output = join(temp, 'site-dist');
  mkdirSync(output); writeFileSync(join(output, 'diagnostics.html'), 'stale'); writeFileSync(join(output, 'audition.html'), 'stale');
  stageSite({ integration, catalog, output });
  assert.deepEqual(readdirSync(output).filter(path => path.endsWith('.html')).sort(), ['catalog.html', 'index.html', 'playground.html']);
  assert.deepEqual(readdirSync(join(output, 'assets')).sort(), ['catalog.js', 'integration.js']);
  for (const [file, href] of [['catalog.html', '/catalog.html'], ['playground.html', '/playground.html']]) {
    const html = readFileSync(join(output, file), 'utf8');
    assert(html.includes(`href="${href}" aria-current="page"`)); assert.match(html, /id="main-content"/);
    assert.doesNotMatch(html, /(?:diagnostics|audition)\.html/);
  }
  assert.throws(() => stageSite({ integration, catalog: { ...catalog, pack: { integrity: 'different' } }, output }), /different package/);
  writeFileSync(join(catalog.output, 'assets', 'integration.js'), 'collision');
  assert.throws(() => stageSite({ integration, catalog, output }), /Conflicting site asset/);
});
