import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { buildSite } from '../scripts/build-site.mjs';

const root = join(import.meta.dirname, '..');
test('deployed site keeps instrument/FX, silent gate and module audition usable', {timeout: 180000}, async () => {
  const artifacts = join(root, 'artifacts/site', new Date().toISOString().replaceAll(':', '-'));
  mkdirSync(artifacts, {recursive: true});
  const manifest = {status: 'CANDIDATE', runtimeGate: 'NOT_CLEARED', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), sourceDirty: execFileSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}).trim() !== '', checks: []};
  let server, browser;
  try {
    const {output, diagnostic, integration, catalog} = buildSite();
    manifest.packageIntegrity = diagnostic.pack.integrity;
    assert.equal(diagnostic.pack.integrity, integration.pack.integrity);
    assert.equal(diagnostic.pack.integrity, catalog.pack.integrity);
    const config = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
    assert.equal(config.buildCommand, 'npm run build:site');
    assert.equal(config.outputDirectory, 'site-dist');
    for (const path of ['index.html', 'diagnostics.html', 'audition.html', 'catalog.html']) assert(readFileSync(join(output, path)).length > 0);
    manifest.html = Object.fromEntries(['index.html', 'diagnostics.html', 'audition.html', 'catalog.html'].map(path => [path, createHash('sha256').update(readFileSync(join(output, path))).digest('hex')]));
    manifest.wasm = readdirSync(join(output, 'assets')).filter(path => path.endsWith('.wasm'));
    server = await preview({root, configFile: false, build: {outDir: output}, preview: {host: '127.0.0.1', port: 0}});
    browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox']});
    const page = await browser.newPage({viewport: {width: 390, height: 844}}), errors = [], failed = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);});
    const url = server.resolvedUrls.local[0];
    await page.goto(url);
    assert.equal(await page.locator('#instrument option').count(), 4);
    assert.equal(await page.locator('#effect option').count(), 3);
    assert.match(await page.locator('#status').innerText(), /Audio is off/);
    for (const [sound, effect] of [['bass', 'chorus'], ['pad', 'rhythmic']]) {
      await page.selectOption('#instrument', sound); await page.selectOption('#effect', effect);
      await page.click('#start');
      await page.waitForFunction(() => window.denIntegration?.state().ready);
      await page.locator('#chord').focus(); await page.keyboard.down('Space');
      await page.waitForTimeout(500); await page.keyboard.up('Space');
      await page.click('#release'); await page.click('#stop');
      await page.waitForFunction(() => !document.querySelector('#instrument').disabled);
      manifest.checks.push(`${sound}/${effect}: deployed Start, hold, Release, Stop`);
    }
    await page.locator('a[href="/diagnostics.html"]').click();
    await page.click('#run'); await page.waitForFunction(() => document.querySelector('#result').textContent.startsWith('Passed at 48000 Hz.'));
    manifest.checks.push('deployed silent package gain/snapshot gate');
    await page.locator('a[href="/audition.html"]').click();
    await page.click('#start'); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Playing'));
    await page.click('#stop'); await page.waitForFunction(() => document.querySelector('#peak').textContent.includes('closed'));
    manifest.checks.push('preserved module audition Start/Stop');
    await page.getByRole('link', {name: 'Silent entry check', exact: true}).click();
    assert.equal(new URL(page.url()).pathname, '/diagnostics.html');
    assert.equal(await page.locator('#run').count(), 1);
    manifest.checks.push('module audition return link targets silent diagnostics');
    assert.deepEqual(errors, []); assert.deepEqual(failed, []);
    await page.goto(url); assert.equal(await page.locator('#instrument').inputValue(), 'diagnostic');
    await page.screenshot({path: join(artifacts, 'initial-candidate.png'), fullPage: true});
    await page.locator('a[href="/catalog.html"]').click();
    await page.waitForFunction(() => !!window.denCatalog);
    assert.equal((await page.evaluate(() => window.denCatalog.state())).started, 0);
    assert.equal(await page.locator('[data-example]').count(), 4);
    await page.getByRole('link', {name: 'Initial sound / FX candidate', exact: true}).click();
    assert.equal(new URL(page.url()).pathname, '/');
    manifest.checks.push('catalog route has no autoplay and returns to the unchanged initial candidate');
    manifest.checks.push('fresh root navigation has stopped default state, no page/asset errors');
  } catch (error) {manifest.failure = String(error); throw error;}
  finally {
    writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await browser?.close();
    if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  }
});
