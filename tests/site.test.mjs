import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { buildSite } from '../scripts/build-site.mjs';

const root = join(import.meta.dirname, '..');
test('public site removal: old pages and assets return404 and root has no former UI', { timeout: 60000 }, async () => {
  const artifacts = join(root, 'artifacts/site-removal', new Date().toISOString().replaceAll(':', '-')); mkdirSync(artifacts, { recursive: true });
  const manifest = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '', checks: [] };
  let server, browser;
  try {
    const { output } = buildSite();
    assert.deepEqual(readdirSync(output), ['index.html']);
    const config = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')); assert.equal(config.buildCommand, 'npm run build:site'); assert.equal(config.outputDirectory, 'site-dist');
    server = await preview({ root, configFile: false, appType: 'mpa', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const url = server.resolvedUrls.local[0];
    for (const path of ['catalog.html', 'audition.html', 'diagnostics.html', 'playground.html', 'catalog-home.js', 'site.css', 'assets/old.js', 'assets/old.wasm']) {
      const response = await page.request.get(new URL(path, url).href); assert.equal(response.status(), 404, `${path} is removed`);
    }
    await page.goto(url);
    assert.equal(await page.locator('main').innerText(), 'Rebuilding the playground.');
    assert.equal(await page.locator('a,button,input,select,audio,video,canvas,script,link,img').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, 'removed-mobile.png'), fullPage: true });
    manifest.checks.push('clean output contains only minimal root; all former UI routes and assets404; no navigation, player, scripts or assets retained');
  } catch (error) { manifest.failure = String(error); throw error; }
  finally { writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2)); await browser?.close(); if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())); }
});
