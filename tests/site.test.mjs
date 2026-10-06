import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { buildSite } from '../scripts/build-site.mjs';
const root = join(import.meta.dirname, '..');
const smoke = process.env.DEN_PLAYGROUND_SCOPE === 'smoke';
test('packed playground: actual editor assistance and native audio lifecycle', { timeout: smoke ? 300000 : 600000 }, async () => {
  const artifacts = join(root, 'artifacts/playground', new Date().toISOString().replaceAll(':', '-')); mkdirSync(artifacts, { recursive: true });
  const manifest = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '', scope: smoke ? 'two-example-preview' : 'all-examples', checks: [], rows: [], listening: 'NOT_PERFORMED' };
  let server, browser, page;
  try {
    const { output, playground } = buildSite();
    manifest.packageIntegrity = playground.pack.integrity;
    const provenance = JSON.parse(readFileSync(join(output, 'provenance.json'), 'utf8'));
    assert.equal(provenance.candidate.sourceCommit, manifest.sourceCommit);
    assert.equal(provenance.candidate.packageIntegrity, manifest.packageIntegrity);
    assert.equal(provenance.examples.length, Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).exports).length);
    assert.equal(provenance.examples.length, 54);
    server = await preview({ root, configFile: false, appType: 'mpa', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'], ignoreDefaultArgs: ['--disable-back-forward-cache'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'tr-TR' });
    page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    const url = server.resolvedUrls.local[0];
    for (const path of ['catalog.html', 'audition.html', 'diagnostics.html', 'playground.html', 'catalog-home.js', 'site.css', 'assets/old.js', 'assets/old.wasm']) assert.equal((await page.request.get(new URL(path, url).href)).status(), 404, path);
    await page.goto(url); await page.waitForFunction(() => !!window.__denPlayground);
    await page.waitForFunction(() => document.querySelector('#type-status').textContent === 'Types checked.', undefined, { timeout: 45000 });
    assert.equal(await page.locator('#modules a').count(), 54);
    assert.equal(await page.locator('.host a').getAttribute('href'), `https://github.com/yuichkun/den/blob/${manifest.sourceCommit}/playground/README.md`);
    assert.equal((await page.evaluate(() => window.__denPlayground.state())).created, 0);
    await page.screenshot({ path: join(artifacts, 'editor-desktop.png') });
    const state = () => page.evaluate(() => window.__denPlayground.state());
    const stop = async () => {
      await page.click('#stop'); await page.waitForFunction(() => window.__denPlayground.state().phase === 'idle');
      const result = await state(); assert.equal(result.contextState, 'closed'); assert.equal(result.created, result.closed); assert.equal(result.output.peak, 0);
    };
    const run = async id => {
      await page.locator(`#modules a[href="?module=${id}"]`).click();
      await page.waitForFunction(() => ['idle', 'error'].includes(window.__denPlayground.state().phase));
      await page.click('#run');
      await page.waitForFunction(() => ['playing', 'error'].includes(window.__denPlayground.state().phase), undefined, { timeout: 45000 });
      let result = await state(); assert.equal(result.phase, 'playing', `${id}: ${result.error}`);
      // Some generators pulse. Sample the actual post-master graph for up to 2 s.
      for (let i = 0; i < 20; i++) { await page.waitForTimeout(100); result = await state(); if (result.output.rms > .00005) break; }
      assert(result.raw.finite && result.output.finite, id);
      assert(result.output.rms > .00005, `${id} must produce actual native output`);
      assert(result.raw.peak < 1, `${id} unexpectedly clips before master`);
      manifest.rows.push({ id, peak: result.raw.peak, rms: result.output.rms, parameters: result.params, inputs: result.inputNames });
      await stop();
    };
    await run('oscillator'); await run('filter'); await run('oscillator');
    manifest.checks.push('generator + input effect produce finite native output; repeated Run/Stop closes every AudioContext');
    // Query actual Monaco UI providers, not a duplicate type-service test.
    await page.locator('#modules a[href="?module=filter"]').click();
    const filterSource = await page.evaluate(() => window.__denPlayground.model.getValue());
    await page.evaluate(() => {
      const { model, editor } = window.__denPlayground;
      const source = model.getValue().replace('lowpass.tick(', 'lowpass.\n/* completion */tick('); model.setValue(source);
      editor.setPosition(model.getPositionAt(source.indexOf('lowpass.') + 'lowpass.'.length)); editor.focus(); editor.trigger('test', 'editor.action.triggerSuggest', {});
    });
    await page.getByRole('option', { name: /tick/ }).first().waitFor({ timeout: 30000 });
    await page.screenshot({ path: join(artifacts, 'completion.png') }); await page.keyboard.press('Escape');
    await page.evaluate(source => window.__denPlayground.model.setValue(source), filterSource);
    await page.waitForFunction(() => document.querySelector('#type-status').textContent === 'Types checked.');
    manifest.checks.push('actual Monaco member completion contains native filter.tick');
    await page.evaluate(() => {
      const { model, editor } = window.__denPlayground;
      editor.setPosition(model.getPositionAt(model.getValue().indexOf('filter }') + 2)); editor.focus();
      editor.trigger('test', 'editor.action.showHover', {});
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.monaco-hover')].some(item => item.textContent.includes('SubgraphDecl')));
    await page.screenshot({ path: join(artifacts, 'hover.png') }); await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const { model, editor } = window.__denPlayground;
      editor.setPosition(model.getPositionAt(model.getValue().indexOf('lowpass.tick(') + 'lowpass.tick('.length)); editor.focus();
      editor.trigger('test', 'editor.action.triggerParameterHints', {});
    });
    await page.waitForFunction(() => document.querySelector('.parameter-hints-widget.visible')?.textContent.includes('resonance'));
    await page.screenshot({ path: join(artifacts, 'signature.png') }); await page.keyboard.press('Escape');
    manifest.checks.push('actual Monaco hover resolves SubgraphDecl and signature widget resolves filter tick arguments');

    await page.evaluate(() => window.__denPlayground.model.setValue('export default ;'));
    await page.waitForFunction(() => window.__denPlayground.state().markers.length > 0);
    await page.click('#run'); await page.waitForFunction(() => window.__denPlayground.state().phase === 'error');
    assert.match(await page.locator('#run-error').innerText(), /TypeScript/);
    assert.equal((await state()).created, (await state()).closed);
    await page.click('#reset'); await run('filter');
    manifest.checks.push('syntax diagnostics block native startup, close context, and Reset/Run recovers');
    await page.click('#run'); await page.waitForFunction(() => window.__denPlayground.state().phase === 'playing');
    await page.getByRole('spinbutton', { name: 'cutoff', exact: true }).fill('250');
    assert.equal((await state()).params.find(item => item.name === 'cutoff').value, 250);
    const cutoffSlider = page.getByRole('slider', { name: 'cutoff slider', exact: true });
    assert.equal(Number(await cutoffSlider.inputValue()), 250);
    await cutoffSlider.focus(); await page.keyboard.press('Home'); await page.waitForTimeout(300);
    const lowCutoff = await state(); assert.equal(lowCutoff.params.find(item => item.name === 'cutoff').value, 40);
    assert.equal(Number(await page.getByRole('spinbutton', { name: 'cutoff', exact: true }).inputValue()), 40);
    await page.keyboard.press('End'); await page.waitForTimeout(300);
    const highCutoff = await state(); assert.equal(highCutoff.params.find(item => item.name === 'cutoff').value, 8000);
    assert(highCutoff.output.rms > lowCutoff.output.rms * 1.2, 'The cutoff slider changes native filtered audio');
    const sliderBox = await cutoffSlider.boundingBox(); assert(sliderBox);
    await cutoffSlider.click({ position: { x: sliderBox.width * .35, y: sliderBox.height / 2 } });
    const pointerCutoff = (await state()).params.find(item => item.name === 'cutoff').value;
    assert(pointerCutoff > 40 && pointerCutoff < 8000);
    assert.equal(Number(await page.getByRole('spinbutton', { name: 'cutoff', exact: true }).inputValue()), pointerCutoff);
    assert.equal(Number(await cutoffSlider.inputValue()), pointerCutoff);
    await page.locator('#volume').focus(); await page.keyboard.press('Home'); await page.waitForTimeout(150);
    assert((await state()).output.peak < .000001, 'Output slider really mutes the native graph');
    for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150); assert((await state()).output.rms > .00005);
    await page.screenshot({ path: join(artifacts, 'running-parameters.png') }); await stop();
    manifest.checks.push('AudioParam slider/number synchronize; keyboard/pointer preserve native bounds and cutoff changes audio; master mute/restore works');
    await page.locator('#modules a[href="?module=sample"]').click();
    const sampleSource = await page.evaluate(() => window.__denPlayground.model.getValue());
    assert(sampleSource.includes('value: data.length'));
    await page.evaluate(source => window.__denPlayground.model.setValue(source.replace('value: data.length', 'value: data.length + 1')), sampleSource);
    await page.click('#run'); await page.waitForFunction(() => window.__denPlayground.state().phase === 'error', undefined, { timeout: 45000 });
    assert.match(await page.locator('#run-error').innerText(), /(?:Asset preparation|Native asset acknowledgement) timed out/);
    assert.equal((await state()).created, (await state()).closed); assert.equal((await state()).output.peak, 0);
    await page.click('#reset'); await run('sample');
    manifest.checks.push('mismatched native asset receipt times out while muted, disposes context, and Reset/Run loads audible PCM');
    await page.locator('#modules a[href="?module=filter"]').click();

    // The graph builder may loop, but Stop and navigation must remain responsive.
    await page.evaluate(source => window.__denPlayground.model.setValue('while (true) {}\n' + source), filterSource);
    await page.click('#run');
    await page.waitForFunction(() => document.querySelector('#audio-status').textContent === 'Compiling…');
    await stop(); await page.click('#reset');
    await page.click('#run'); await page.click('#modules a[href="?module=envelope"]');
    await page.waitForFunction(() => window.__denPlayground.state().phase === 'idle');
    assert.equal((await state()).created, (await state()).closed);
    await page.goBack(); assert.equal(new URL(page.url()).searchParams.get('module'), 'filter');
    assert.equal((await state()).phase, 'idle');
    manifest.checks.push('infinite graph-building loop cancels; navigation cancels compilation; Back never autoplays');
    await page.click('#run');
    await page.evaluate(source => window.__denPlayground.model.setValue(source + '\n// newer edit'), filterSource);
    await page.waitForFunction(() => window.__denPlayground.state().phase === 'idle'); await page.waitForTimeout(300);
    assert.equal((await state()).created, (await state()).closed); assert.equal((await state()).phase, 'idle'); await page.click('#reset');
    manifest.checks.push('editing during compile cancels it and an older result cannot start audio');
    if (!smoke) {
      await page.evaluate(source => window.__denPlayground.model.setValue('while (true) {}\n' + source), filterSource);
      await page.click('#run'); await page.waitForFunction(() => window.__denPlayground.state().phase === 'error', undefined, { timeout: 35000 });
      assert.match(await page.locator('#run-error').innerText(), /Compilation timed out/);
      assert.equal((await state()).created, (await state()).closed); await page.click('#reset'); await run('filter');
      manifest.checks.push('uncancelled infinite user graph is terminated by the real compile deadline and recovers');
    }

    await page.fill('#search', 'MIDI'); assert((await page.locator('#modules a').count()) > 0);
    const uppercase = await page.locator('#modules a').allTextContents(); await page.fill('#search', 'midi'); assert.deepEqual(await page.locator('#modules a').allTextContents(), uppercase);
    await page.fill('#search', 'no-such-module'); assert.equal(await page.locator('#modules a').count(), 0); assert(await page.locator('#no-results').isVisible()); await page.fill('#search', '');
    manifest.checks.push('search is locale-independent under tr-TR, with useful empty state');
    if (!smoke) for (const { id } of provenance.examples) if (!['oscillator', 'filter'].includes(id)) await run(id);
    await page.locator('#modules a[href="?module=filter"]').click();
    await page.waitForFunction(() => document.querySelector('#type-status').textContent === 'Types checked.');
    await page.evaluate(() => { window.__denRestoredFromCache = false; window.addEventListener('pageshow', event => { window.__denRestoredFromCache = event.persisted; }); });
    await page.goto(new URL('provenance.json', url).href); await page.goBack();
    await page.waitForFunction(() => !!window.__denPlayground && document.querySelector('#type-status').textContent === 'Types checked.');
    const restoredFromCache = await page.evaluate(() => window.__denRestoredFromCache === true);
    assert.equal((await state()).phase, 'idle'); assert.equal((await state()).created, (await state()).closed);
    await page.evaluate(() => {
      const { model, editor } = window.__denPlayground;
      const source = model.getValue().replace('lowpass.tick(', 'lowpass.\n/* after back */tick('); model.setValue(source);
      editor.setPosition(model.getPositionAt(source.indexOf('lowpass.') + 'lowpass.'.length)); editor.focus(); editor.trigger('test', 'editor.action.triggerSuggest', {});
    });
    await page.getByRole('option', { name: /tick/ }).first().waitFor({ timeout: 30000 }); await page.keyboard.press('Escape'); await page.click('#reset');
    manifest.checks.push({ check: 'document Back restores completion without audio', restoredFromCache });
    // Exercise persisted lifecycle delivery even if this CI browser declines BFCache.
    // This is explicitly separate from the actual navigation observation above.
    if (!restoredFromCache) {
      await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
      await page.waitForFunction(() => document.querySelector('#type-status').textContent === 'Types checked.');
      assert.equal((await state()).phase, 'idle');
      manifest.checks.push('persisted lifecycle events recreate real type assistance; browser did not use BFCache for this navigation');
    }

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, 'editor-mobile.png') });
    await page.click('#open-library'); await page.fill('#search', 'envelope'); await page.click('#modules a[href="?module=envelope"]');
    assert.equal(await page.locator('.library').isVisible(), false); await page.click('#run');
    await page.waitForFunction(() => ['playing', 'error'].includes(window.__denPlayground.state().phase), undefined, { timeout: 45000 }); assert.equal((await state()).phase, 'playing');
    assert(await page.getByRole('slider', { name: 'attack slider', exact: true }).isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, 'mobile-running-parameters.png'), fullPage: true }); await stop();
    await page.screenshot({ path: join(artifacts, 'mobile-controls.png'), fullPage: true });
    manifest.checks.push('390px mobile module selection, editor, Run/Stop, controls and no horizontal page overflow');
    assert.deepEqual(errors, []);
  } catch (error) { manifest.failure = String(error); if (page) await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {}); throw error; }
  finally { writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2)); await browser?.close(); if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())); }
});
