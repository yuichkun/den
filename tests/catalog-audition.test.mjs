import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { runCatalogLifecycle } from './catalog-audition-lifecycle.mjs';
import { buildSite } from '../scripts/build-site.mjs';
const root = join(import.meta.dirname, '..');
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');

test('catalog deployed bytes: four A/B candidates, native asset preload, actual stereo gain and lifecycle', { timeout: 240000 }, async () => {
  const artifacts = join(root, 'artifacts/catalog-audition', new Date().toISOString().replaceAll(':', '-')); mkdirSync(artifacts, { recursive: true });
  const manifest = { status: 'CANDIDATE', runtimeStatus: 'NOT_CLEARED', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '', checks: [], rows: [], limitations: ['Observed browser windows are not all-device runtime certification', 'Independent offline examples retain full-frame headroom and tail evidence', 'No autoplay, microphone, external MIDI permission or golden promotion'] };
  let server, browser;
  try {
    const built = buildSite();
    assert.equal(built.catalog.pack.integrity, built.integration.pack.integrity); manifest.packageIntegrity = built.catalog.pack.integrity;
    manifest.sources = Object.fromEntries(['package.json', 'scripts/build-site.mjs', 'scripts/build-consumer.mjs', 'tests/catalog-audition.test.mjs', 'tests/catalog-audition-lifecycle.mjs', ...readdirSync(join(root, 'tests/catalog-audition-consumer')).map(x => `tests/catalog-audition-consumer/${x}`)].map(x => [x, hash(join(root, x))]));
    manifest.htmlSHA256 = hash(join(built.output, 'catalog.html'));
    const buildIdentity = JSON.parse(readFileSync(join(built.catalog.consumer, 'candidate-provenance.json'), 'utf8'));
    assert.equal(buildIdentity.sourceCommit, manifest.sourceCommit); assert.equal(buildIdentity.sourceDirty, manifest.sourceDirty);
    server = await preview({ root, configFile: false, build: { outDir: built.output }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), pageErrors = [], failed = [];
    page.on('pageerror', error => pageErrors.push(error.message)); page.on('response', response => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
    const url = new URL('catalog.html', server.resolvedUrls.local[0]).href;
    const state = () => page.evaluate(() => window.denCatalog.state());
    const measure = seconds => page.evaluate(n => window.denCatalog.measure(n), seconds);
    await page.goto(url); await page.waitForFunction(() => !!window.denCatalog);
    assert.equal((await state()).started, 0); assert.equal((await state()).phase, 'idle'); assert.equal(await page.locator('#volume').inputValue(), '1');
    assert.equal(await page.locator('[data-example]').count(), 4); manifest.checks.push('fresh page has no AudioContext/autoplay and unity default master');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, 'catalog-mobile.png'), fullPage: true });
    for (const key of ['glass', 'hit', 'grain', 'echo']) for (const variant of ['A', 'B']) {
      await page.click(`[data-example="${key}"]`); await page.click(`[data-variant="${variant}"]`); await page.click('#start');
      await page.waitForFunction(() => window.denCatalog.state().ready, null, { timeout: 30000 });
      let s = await state(); assert.equal(s.selected, key); assert.equal(s.variant, variant); assert.equal(s.lastError, null); assert.equal(s.sourceCommit, manifest.sourceCommit);
      if (key === 'glass' || key === 'grain') { assert.equal(s.lastAsset.nativeVerified, true); assert.equal(s.lastAsset.length, key === 'glass' ? 384 : 4096); assert.match(s.lastAsset.sha256, /^[0-9a-f]{64}$/); }
      const silent = await measure(.03); assert.equal(silent.sampleRate, 48000); assert(silent.raw.every(x => x.peak === 0));
      // Disabled selectors reject even synthetic changes during a live session.
      await page.locator('[data-example="echo"]').dispatchEvent('click'); await page.locator('[data-variant="B"]').dispatchEvent('click');
      s = await state(); assert.equal(s.selected, key); assert.equal(s.variant, variant);
      await page.evaluate(() => document.activeElement.blur());
      const keys = key === 'glass' ? ['KeyA', 'KeyS'] : ['Space']; for (const code of keys) await page.keyboard.down(code);
      const active = await measure(.15);
      assert(active.raw.every(x => x.finite && x.peak < .35)); assert(active.output.every(x => x.finite && x.peak < .35)); assert(active.raw.some(x => x.peak > 1e-4), `${key}/${variant} audible candidate`);
      assert.equal(active.volume, 1); assert(active.gainResidual.every(x => x < 2e-6), 'unity master must not add hidden attenuation');
      if (key === 'glass' && variant === 'A') {
        await page.locator('#volume').evaluate(el => { el.value = '0.5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
        const attenuated = await measure(.22); assert(Math.abs(attenuated.volume - .5) < 1e-5); assert(attenuated.gainResidual.every(x => x < 2e-6));
        await page.locator('#volume').evaluate(el => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); }); await measure(.22);
      }
      for (const code of keys) await page.keyboard.up(code); await page.click('#release'); assert.deepEqual((await state()).held, []);
      const released = await measure(key === 'echo' ? 1.65 : key === 'hit' ? .65 : .4);
      assert(released.raw.every(x => x.finite && x.peak < 1e-4), `${key}/${variant} bounded release/tail`);
      await page.click('#clear'); await page.waitForFunction(() => window.denCatalog.state().ready);
      const cleared = await measure(.12); assert(cleared.raw.every(x => x.peak === 0));
      await page.click('#stop'); await page.waitForFunction(() => window.denCatalog.state().phase === 'idle');
      s = await state(); assert.equal(s.closed, s.started); assert.equal(s.disposed, s.started); assert.equal(s.lastError, null);
      manifest.rows.push({ key, variant, asset: s.lastAsset, active, released, cleared });
    }
    // Pointer capture/cancellation, two independent held intents, explicit clear
    // during input, and navigation cleanup exercise the actual UI path.
    await page.click('[data-example="glass"]'); await page.click('#start'); await page.waitForFunction(() => window.denCatalog.state().ready);
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.down('KeyA'); await page.keyboard.down('KeyS'); await page.keyboard.up('KeyA');
    assert.deepEqual((await state()).held, ['gateB']); await page.keyboard.up('KeyS');
    const trigger = page.locator('[data-trigger="voice-a"]'); await trigger.hover(); await page.mouse.down();
    assert((await state()).held.includes('gateA')); await page.mouse.up(); assert.deepEqual((await state()).held, []);
    await page.evaluate(() => document.activeElement.blur()); await page.keyboard.down('Space'); await page.click('#clear'); await page.waitForFunction(() => window.denCatalog.state().ready); await page.keyboard.up('Space');
    assert.deepEqual((await state()).held, []); assert((await measure(.12)).raw.every(x => x.peak === 0));
    await page.click('#stop'); await page.waitForFunction(() => window.denCatalog.state().phase === 'idle');
    // Stop while asynchronous startup is in flight. A late node cannot connect.
    await page.evaluate(() => { document.getElementById('start').click(); document.getElementById('stop').click(); });
    await page.waitForFunction(() => window.denCatalog.state().phase === 'idle'); await page.waitForFunction(() => window.denCatalog.state().settled === window.denCatalog.state().started);
    assert.equal((await state()).closed, (await state()).started); assert.equal((await state()).ready, false);
    await page.click('#start'); await page.waitForFunction(() => window.denCatalog.state().ready); await page.evaluate(() => document.activeElement.blur()); await page.keyboard.down('Space');
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide'))); await page.keyboard.up('Space');
    await page.waitForFunction(() => window.denCatalog.state().phase === 'idle'); assert.equal((await state()).closed, (await state()).started);
    assert.deepEqual((await state()).errors.filter(x => x.code !== 'sab-unavailable'), []);
    await page.setViewportSize({ width: 1280, height: 900 }); await page.screenshot({ path: join(artifacts, 'catalog-desktop.png'), fullPage: true });
    await page.getByRole('link', { name: '楽器を弾く', exact: true }).click();
    assert.equal(await page.locator('#instrument option').count(), 4); assert.equal(await page.locator('#effect option').count(), 3);
    manifest.checks.push(...await runCatalogLifecycle(browser, url));
    assert.deepEqual(pageErrors, []); assert.deepEqual(failed, []);
    manifest.checks.push('eight A/B actual stereo auditions, verified native PCM preload, unity/half-gain path, full release windows, clear/stop, selector guards, independent holds, startup cancellation and pagehide cleanup');
  } catch (error) { manifest.failure = String(error); throw error; }
  finally { writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2)); await browser?.close(); if (server) await new Promise((yes, no) => server.httpServer.close(error => error ? no(error) : yes())); }
});
