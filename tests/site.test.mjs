import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { buildSite } from '../scripts/build-site.mjs';
import { modules, categories } from '../site/catalog-data.mjs';

const root = join(import.meta.dirname, '..');
test('deployed catalog: exact public routes, discoverability, navigation and audio lifecycle', { timeout: 240000 }, async () => {
  const artifacts = join(root, 'artifacts/site', new Date().toISOString().replaceAll(':', '-'));
  mkdirSync(artifacts, { recursive: true });
  const manifest = { status: 'CANDIDATE', runtimeGate: 'NOT_CLEARED', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '', checks: [] };
  let server, browser;
  try {
    const { output, integration, catalog } = buildSite();
    manifest.packageIntegrity = integration.pack.integrity;
    assert.equal(integration.pack.integrity, catalog.pack.integrity);
    const config = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
    assert.equal(config.buildCommand, 'npm run build:site');
    assert.equal(config.outputDirectory, 'site-dist');
    // The old diagnostics are physically absent, not merely hidden in navigation.
    assert.deepEqual(readdirSync(output).filter(path => path.endsWith('.html')).sort(), ['catalog.html', 'index.html', 'playground.html']);
    manifest.html = Object.fromEntries(['index.html', 'catalog.html', 'playground.html'].map(path => [path, createHash('sha256').update(readFileSync(join(output, path))).digest('hex')]));
    manifest.wasm = readdirSync(join(output, 'assets')).filter(path => path.endsWith('.wasm'));
    for (const file of Object.keys(manifest.html)) assert.doesNotMatch(readFileSync(join(output, file), 'utf8'), /href=["'][^"']*(?:diagnostics|audition)\.html/);
    server = await preview({ root, configFile: false, appType: 'mpa', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }), errors = [], failed = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
    // Native observation makes the no-autoplay claim independent of UI labels.
    await page.addInitScript(() => {
      const Native = window.AudioContext; window.siteContexts = [];
      window.AudioContext = class extends Native { constructor(...args) { super(...args); window.siteContexts.push(this); } };
    });
    const url = server.resolvedUrls.local[0];
    for (const path of ['diagnostics.html', 'audition.html']) {
      const response = await page.request.get(new URL(path, url).href); assert.equal(response.status(), 404);
    }
    await page.goto(url);
    const shown = () => page.locator('.module-card:visible').count();
    await page.waitForSelector('#catalog-tools:not([hidden])');
    assert.equal(await shown(), modules.length);
    assert.equal(await page.evaluate(() => window.siteContexts.length), 0);
    assert.equal(await page.locator('.study-card').count(), 4);
    for (const category of categories) {
      await page.locator(`[data-filter="${category.id}"]`).click();
      assert.equal(await shown(), modules.filter(item => item.category === category.id).length);
      assert.equal(new URL(page.url()).searchParams.get('category'), category.id);
    }
    await page.goBack(); assert.equal(await page.locator('[data-filter="effects"]').getAttribute('aria-pressed'), 'true');
    await page.goForward(); assert.equal(await page.locator('[data-filter="controls"]').getAttribute('aria-pressed'), 'true');
    await page.locator('#clear-filters').click();
    await page.locator('#catalog-search').fill('DELAY');
    assert((await shown()) > 0 && (await shown()) < modules.length);
    await page.reload(); assert.equal(await page.locator('#catalog-search').inputValue(), 'DELAY');
    await page.locator('#catalog-search').fill('does-not-exist');
    assert.equal(await shown(), 0); assert.equal(await page.locator('#empty-results').isVisible(), true);
    await page.locator('#clear-filters').click(); await page.locator('#demo-filter').check();
    assert.equal(await shown(), modules.filter(item => item.demo).length);
    await page.locator('#clear-filters').click();
    await page.locator('#module-spectral-texture summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#module-spectral-texture details').getAttribute('open'), '');
    assert.match(await page.locator('#module-spectral-texture .module-detail').innerText(), /@denaudio\/den\/spectral-texture/);
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: join(artifacts, `home-${viewport.width}.png`), fullPage: true });
    }
    manifest.checks.push('all actual exports classified; mobile/desktop layout; search, category, demo-only, empty/reset, keyboard details and Back/Forward/reload restore');
    // Follow a real discovery card, with a nondefault initial material.
    await page.getByRole('link', { name: 'Grain cloud を A/B 試聴', exact: true }).click();
    await page.waitForFunction(() => !!window.denCatalog);
    assert.equal((await page.evaluate(() => window.denCatalog.state())).selected, 'grain');
    assert.equal(await page.evaluate(() => window.siteContexts.length), 0);
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.click('#start'); await page.waitForFunction(() => window.denCatalog.state().ready);
      await page.locator('[data-trigger="texture"]').focus(); await page.keyboard.down('Space');
      const active = await page.evaluate(() => window.denCatalog.measure(.2));
      assert(active.raw.some(channel => channel.rms > 1e-5)); assert(active.raw.every(channel => channel.finite));
      await page.keyboard.up('Space'); await page.click('#release'); await page.click('#stop');
      await page.waitForFunction(() => window.denCatalog.state().phase === 'idle');
      assert.equal(await page.evaluate(() => window.siteContexts.every(context => context.state === 'closed')), true);
    }
    await page.getByRole('link', { name: 'カタログ', exact: true }).click();
    await page.goBack(); await page.waitForFunction(() => !!window.denCatalog);
    assert.equal((await page.evaluate(() => window.denCatalog.state())).phase, 'idle');
    await page.goForward();
    await page.locator('#module-delay-fx .module-demo').click();
    await page.waitForFunction(() => !!window.denIntegration);
    assert.equal(new URL(page.url()).pathname, '/playground.html');
    assert.equal(await page.locator('#instrument').inputValue(), 'pad');
    assert.equal(await page.locator('#effect').inputValue(), 'chorus');
    assert.equal(await page.evaluate(() => window.siteContexts.length), 0);
    for (const [sound, effect] of [['bass', 'chorus'], ['pad', 'rhythmic']]) {
      await page.selectOption('#instrument', sound); await page.selectOption('#effect', effect);
      await page.click('#start'); await page.waitForFunction(() => window.denIntegration.state().ready);
      await page.locator('#chord').focus(); await page.keyboard.down('Space');
      await page.waitForFunction(() => window.denIntegration.state().peak > 1e-5);
      await page.keyboard.up('Space'); await page.click('#release'); await page.click('#stop');
      await page.waitForFunction(() => !document.querySelector('#instrument').disabled);
      assert.equal(await page.evaluate(() => window.siteContexts.every(context => context.state === 'closed')), true);
      manifest.checks.push(`${sound}/${effect}: deployed Start, measured nonzero output, hold, Release, Stop`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, 'playground-mobile.png'), fullPage: true });
    await page.goto(new URL('catalog.html?example=not-a-material', url).href);
    await page.waitForFunction(() => !!window.denCatalog); assert.equal((await page.evaluate(() => window.denCatalog.state())).selected, 'glass');
    assert.equal(await page.evaluate(() => window.siteContexts.length), 0);
    assert.deepEqual(errors, []); assert.deepEqual(failed, []);
    manifest.checks.push('obsolete public routes return404; only catalog/listening/playground HTML is staged; native audio repeat/stop and navigation remain silent on return; unknown deep link is safely defaulted');
  } catch (error) { manifest.failure = String(error); throw error; }
  finally {
    writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await browser?.close();
    if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  }
});
