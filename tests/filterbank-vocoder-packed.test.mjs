import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '..'), hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
test('packed public vocoder: independent native render/continuation and actual 48k carrier modulation', { timeout: 240000 }, async () => {
  assert(!(process.env.CI && process.env.DEN_FILTERBANK_SKIP_BROWSER === '1'), 'Hosted CI must execute the actual vocoder browser gate');
  const consumer = mkdtempSync(join(tmpdir(), 'den-filterbank-vocoder-'));
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], root).trim(), artifacts = join(root, 'artifacts/filterbank-vocoder', new Date().toISOString().replaceAll(':', '-') + '-' + sourceCommit.slice(0, 7)); mkdirSync(artifacts, { recursive: true });
  const sources = ['package.json', 'package-lock.json', 'src/filterbank-vocoder.ts', 'src/state-variable-filter.ts', 'src/catalog-filter-math.ts', 'src/dynamics.ts', 'docs/filterbank-vocoder-entry.md', 'tests/filterbank-vocoder.spec.ts', 'tests/filterbank-vocoder-packed.test.mjs', ...readdirSync(join(root, 'tests/filterbank-vocoder-consumer')).map(name => `tests/filterbank-vocoder-consumer/${name}`)];
  const manifest = { status: 'CANDIDATE', sourceCommit, sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(path => [path, hash(join(root, path))])), node: process.version, unworklet: '0.4.1', consumer, checks: {}, files: {}, limitations: ['Not human-approved', 'No speech-intelligibility/quality or flat bank-reconstruction claim', 'No arbitrary-overload guarantee or hidden normalization/limiter', 'Actual browser at 48 kHz only; local cost is not realtime/concurrency acceptance'] };
  let server, browser;
  try {
    for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', file), join(consumer, file));
    cpSync(join(root, 'tests/filterbank-vocoder-consumer'), consumer, { recursive: true });
    const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
    for (const name of ['filterbank-vocoder', 'state-variable-filter', 'catalog-filter-math', 'dynamics']) for (const ext of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/${name}.${ext}`));
    copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz')); manifest.packageIntegrity = pack.integrity;
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8')); lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity; writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
    run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer); manifest.checks.install = 'PASS';
    assert.deepEqual(JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'))).exports['./filterbank-vocoder'], { types: './dist/filterbank-vocoder.d.ts', import: './dist/filterbank-vocoder.js' });
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
    run('npm', ['run', 'check'], consumer); manifest.checks.publicTypecheck = 'PASS';
    console.log(run('node', ['render.mjs'], consumer)); manifest.checks.nativeOffline = 'PASS';
    console.log(run('npm', ['run', 'build'], consumer)); manifest.checks.workletBuild = 'PASS';
    manifest.wasmHashes = Object.fromEntries(readdirSync(join(consumer, 'dist/assets')).filter(path => path.endsWith('.wasm')).map(path => [path, hash(join(consumer, 'dist/assets', path))]));
    cpSync(join(consumer, 'dist'), join(artifacts, 'worklet-dist'), { recursive: true });
    if (process.env.DEN_FILTERBANK_SKIP_BROWSER === '1') {
      manifest.checks.browser48000 = 'NOT_RUN: explicitly delegated to hosted browser validation';
    } else {
    const { preview } = await import(pathToFileURL(join(consumer, 'node_modules/vite/dist/node/index.js')).href); server = await preview({ root: consumer, configFile: false, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(); await page.goto(server.resolvedUrls.local[0]); await page.waitForFunction(() => typeof window.runFilterBankVocoder === 'function');
    const result = await page.evaluate(() => window.runFilterBankVocoder()); writeFileSync(join(artifacts, 'browser.json'), JSON.stringify(result, null, 2)); manifest.files['browser.json'] = hash(join(artifacts, 'browser.json'));
    assert.equal(result.sampleRate, 48000); assert(result.active.every(x => x.finite)); assert(Math.abs(result.active[1].mean - 2 / Math.PI) < .03); assert(Math.abs(result.active[0].rms - Math.SQRT2 / Math.PI) < .03);
    assert(result.doubled.every(x => x.finite)); assert(Math.abs(result.doubled[0].rms / result.active[0].rms - 2) < .1);
    assert(result.carrierSilent[0].finite && result.carrierSilent[0].peak < 1e-7); assert(result.carrierSilent[1].mean > 1);
    const savedControls = [0, 1, Math.fround(.01), 30, 0];
    for (const stage of ['beforeSave', 'controlsPrepared', 'afterRestore']) {
      assert(result[stage].every(x => x.finite), stage);
      assert.deepEqual(result[stage].slice(2).map(x => x.mean), savedControls, `${stage}: rendered saved controls`);
    }
    assert(result.beforeSave[1].mean > 1 && result.beforeSave[0].rms > .5, 'nonzero saved envelope and audio');
    for (const stage of ['mutated', 'controlsPrepared', 'cleared']) assert(result[stage].slice(0, 2).every(x => x.finite && x.peak === 0), `${stage}: genuinely cleared DSP state`);
    assert.equal(result.restored.ok, true);
    // Both analyser windows have equal length; their midpoint offsets cancel.
    // Bound native snapshot/restore delivery by measured context-clock brackets
    // plus eight quanta for graph publication and analyser-window alignment.
    const slack = 8 * 128 / result.sampleRate;
    const elapsedMin = Math.max(0, result.snapshotBefore - result.beforeSave[1].at + result.afterRestore[1].at - result.restoreAfter - slack);
    const elapsedMax = result.snapshotAfter - result.beforeSave[1].at + result.afterRestore[1].at - result.restoreBefore + slack;
    assert(elapsedMax >= elapsedMin && elapsedMax < 2, 'bounded observed decay interval');
    const lower = result.beforeSave[1].mean * Math.exp(-elapsedMax / 30), upper = result.beforeSave[1].mean * Math.exp(-elapsedMin / 30);
    assert(result.afterRestore[1].mean >= lower - 3e-6 && result.afterRestore[1].mean <= upper + 3e-6, `restored envelope ${result.afterRestore[1].mean} outside decay bounds ${lower}..${upper}`);
    assert(Math.abs(result.afterRestore[0].rms / result.afterRestore[1].mean - Math.SQRT1_2) < .02, 'restored envelope drives actual carrier audio');
    assert.deepEqual(result.errors.filter(e => e.code !== 'sab-unavailable'), []); manifest.checks.browser48000 = 'PASS';
    }
  } catch (error) { manifest.failure = String(error); throw error; }
  finally {
    for (const file of ['den.tgz', 'package-lock.json', 'filterbank-vocoder-results.json', 'candidate-filterbank-vocoder-48000.wav']) {
      try { copyFileSync(join(consumer, file), join(artifacts, file)); manifest.files[file] = hash(join(artifacts, file)); } catch {}
    }
    writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2)); await browser?.close(); if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
    console.log(`Filter-bank vocoder evidence: ${artifacts}`);
  }
});
