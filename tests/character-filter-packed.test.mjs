import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const root = join(import.meta.dirname, '..');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, npm_config_cache: process.env.npm_config_cache || join(tmpdir(), 'den-npm-cache') } });
let setup;
function prepare() {
  if (setup) return setup;
  const consumer = mkdtempSync(join(tmpdir(), 'den-character-filter-'));
  const artifacts = join(root, 'artifacts/character-filter', new Date().toISOString().replaceAll(':', '-')); mkdirSync(artifacts, { recursive: true });
  const sources = ['src/character-filter.ts', 'docs/character-filter.md', 'tests/character-filter.spec.ts', 'tests/fixtures/character-filter-reference.ts', 'tests/character-filter-packed.test.mjs', 'package.json', 'package-lock.json', ...readdirSync(join(root, 'tests/character-filter-consumer')).map(x => `tests/character-filter-consumer/${x}`)];
  const manifest = { status: 'CANDIDATE', runtimeStatus: 'NOT_CLEARED', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(p => [p, hash(join(root, p))])), dependency: '@unworklet/* 0.4.1', sampleRates: [44100, 48000, 96000], checks: { browser: 'NOT_RUN' }, files: {}, limitations: ['base-rate nonlinear harmonics can alias', 'individual poleHz is not whole-loop -3dB cutoff', 'not analog-circuit emulation', 'not an approved golden or listening approval', 'not real-time clearance'] };
  const save = () => writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2));
  setup = { consumer, artifacts, manifest, save };
  try {
    for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', name), join(consumer, name));
    cpSync(join(root, 'tests/character-filter-consumer'), consumer, { recursive: true });
    copyFileSync(join(root, 'tests/fixtures/character-filter-reference.ts'), join(consumer, 'reference.ts'));
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
    const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
    for (const extension of ['js', 'd.ts']) assert(pack.files.some(x => x.path === `dist/character-filter.${extension}`));
    copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8')); lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
    writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock)); manifest.packageIntegrity = pack.integrity;
    run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer); manifest.checks.install = 'PASS';
    run('npm', ['run', 'check'], consumer); manifest.checks.typecheck = 'PASS';
    for (const name of ['den.tgz', 'package-lock.json']) { copyFileSync(join(consumer, name), join(artifacts, name)); manifest.files[name] = hash(join(artifacts, name)); }
    return setup;
  } catch (error) { manifest.failure = String(error); throw error; } finally { save(); }
}

test('character filter isolated package: public entry, independent three-rate renders, snapshot and candidate evidence', { timeout: 180000 }, () => {
  const { consumer, artifacts, manifest, save } = prepare();
  try {
    run('node', ['render.ts'], consumer); manifest.checks.offline = 'PASS';
    for (const name of readdirSync(consumer).filter(x => /\.(f32|f64|wav|svg)$/.test(x) || x === 'character-filter-evidence.json')) {
      copyFileSync(join(consumer, name), join(artifacts, name)); manifest.files[name] = hash(join(artifacts, name));
    }
    run('npm', ['run', 'build'], consumer); manifest.checks.workletBuild = 'PASS';
    manifest.wasm = Object.fromEntries(readdirSync(join(consumer, 'dist/assets')).filter(x => x.endsWith('.wasm')).map(x => [x, hash(join(consumer, 'dist/assets', x))]));
  } catch (error) { manifest.failure = String(error); throw error; } finally { save(); }
});

test('character filter actual 48 kHz browser: parameters, noninitial history and native snapshot restoration', { timeout: 180000 }, async () => {
  const { consumer, artifacts, manifest, save } = prepare(); let browser, server;
  const dc = (input, resonance, drive) => { let lo = -1, hi = 1; for (let i = 0; i < 80; i++) { const y = (lo + hi) / 2; let value = input * drive - 4 * resonance * y; for (let j = 0; j < 4; j++) value /= Math.hypot(1, value); if (y > value) hi = y; else lo = y; } return (lo + hi) / 2; };
  try {
    run('npm', ['run', 'build'], consumer);
    const { preview } = await import(pathToFileURL(join(consumer, 'node_modules/vite/dist/node/index.js')).href);
    server = await preview({ root: consumer, configFile: false, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(); await page.goto(server.resolvedUrls.local[0]); await page.waitForFunction(() => typeof window.runCharacterFilter === 'function');
    const result = await page.evaluate(() => window.runCharacterFilter());
    writeFileSync(join(artifacts, 'browser.json'), JSON.stringify(result, null, 2)); manifest.files['browser.json'] = hash(join(artifacts, 'browser.json'));
    assert.equal(result.sampleRate, 48000);
    for (const name of ['driven', 'lowerDrive', 'lowerResonance', 'lowPole', 'highPole', 'history', 'cleared', 'beforeRestore', 'afterRestore']) { assert(result[name].finite); assert(result[name].peak <= .50000006); }
    assert(Math.abs(result.driven.mean - dc(.25, Math.fround(.7), 8)) < 1e-5);
    assert(Math.abs(result.lowerDrive.mean - dc(.25, Math.fround(.7), 2)) < 1e-5);
    assert(Math.abs(result.lowerResonance.mean - dc(.25, 0, 2)) < 1e-5);
    assert(result.driven.mean > result.lowerDrive.mean + .05); assert(result.lowerResonance.mean > result.lowerDrive.mean + .05);
    assert(result.highPole.rms > 10 * result.lowPole.rms); assert(result.highPole.rms > .02);
    assert(result.history.peak > .1); assert.equal(result.cleared.peak, 0); assert.equal(result.beforeRestore.peak, 0);
    assert.equal(result.restored.ok, true); assert(result.afterRestore.peak > .001);
    assert.deepEqual(result.errors.filter(e => e.code !== 'sab-unavailable'), []); manifest.checks.browser = 'PASS';
  } catch (error) { manifest.checks.browser = 'FAILED'; manifest.failure = String(error); throw error; }
  finally { save(); await browser?.close(); if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())); }
});
