import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { steadyPattern, PERIOD, parameterNames } from './spectral-texture-browser-consumer/oracle.mjs';

const root = join(import.meta.dirname, '..');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (command, args, cwd) => execFileSync(command, command === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args,
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });

test('packed spectral textures: observed native phase, dual-input magnitudes and guarded state restore in browser', { timeout: 180000 }, async () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-spectral-texture-browser-'));
  const artifacts = join(root, 'artifacts/spectral-texture-browser', new Date().toISOString().replaceAll(':', '-'));
  mkdirSync(artifacts, { recursive: true });
  const sourcePaths = ['package.json', 'package-lock.json', ...readdirSync(join(root, 'src')).filter(path => path.endsWith('.ts')).map(path => `src/${path}`),
    'tests/spectral-texture-browser.test.mjs', ...readdirSync(join(root, 'tests/spectral-texture-browser-consumer')).map(path => `tests/spectral-texture-browser-consumer/${path}`)];
  const manifest = { status: 'CANDIDATE', runtimeStatus: 'NOT_CLEARED', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(),
    sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sourcePaths.map(path => [path, hash(join(root, path))])), checks: {},
    consumerRetention: 'Only this newly created consumer dependency installation is removed; tarball, lock, fixtures, build and evidence remain',
    limitations: ['N64/H32 functional composition, not maximum-capacity or device deadline clearance',
      'Native phase indexes an independent dense DFT/WOLA waveform; no fitted phase, constant or RMS-only acceptance',
      'Weak-bin phase floor and magnitude replacement are deliberate texture algorithms, not phase-vocoder transparency',
      'Saved controls render before native restore while the persistent negative source still differs',
      'Browser checks whole-graph source/state recovery; exact short overlap continuation remains separately proved offline'] };
  let browser, server;
  try {
    cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
    cpSync(join(root, 'tests/spectral-texture-browser-consumer'), consumer, { recursive: true });
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      skipLibCheck: false, noEmit: true, allowImportingTsExtensions: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
    const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
    copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
    writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock)); manifest.packageIntegrity = pack.integrity;
    run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
    run('npm', ['run', 'check'], consumer); manifest.checks.types = 'PASS';
    const offline = run('node', ['render.mjs'], consumer); writeFileSync(join(artifacts, 'native-composition.json'), offline);
    manifest.checks.offline = 'PASS';
    run('npm', ['run', 'build'], consumer); manifest.checks.build = 'PASS';
    manifest.wasm = Object.fromEntries(readdirSync(join(consumer, 'dist/assets')).filter(path => path.endsWith('.wasm')).map(path => [path, hash(join(consumer, 'dist/assets', path))]));
    const { preview } = await import(pathToFileURL(join(consumer, 'node_modules/vite/dist/node/index.js')).href);
    server = await preview({ root: consumer, configFile: false, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(); await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => typeof window.runSpectralTexture === 'function');
    const result = await page.evaluate(() => window.runSpectralTexture());
    writeFileSync(join(artifacts, 'browser.json'), JSON.stringify(result, null, 2));
    assert.equal(result.sampleRate, 48000); assert.deepEqual(result.errors.filter(error => error.code !== 'sab-unavailable'), []);
    const phases = result.phases, checked = [];
    const verify = (name, params, inverted = false) => {
      const actual = phases[name], expected = steadyPattern(params, inverted), errors = Array(5).fill(0);
      assert.equal(actual.length, 12); assert(actual.every(channel => channel.finite));
      const clock = actual[4].samples; assert.equal(clock.length, 2048);
      for (let n = 0; n < clock.length; n++) {
        const phase = clock[n]; assert(Number.isInteger(phase) && phase >= 0 && phase < PERIOD, `${name} native phase ${phase}`);
        if (n) assert.equal(phase, (clock[n - 1] + 1) % PERIOD, `${name} native sample progression`);
        for (let channel = 0; channel < 5; channel++) errors[channel] = Math.max(errors[channel], Math.abs(actual[channel].samples[n] - expected[channel][phase]));
      }
      for (let channel = 0; channel < 5; channel++) assert(errors[channel] < (channel < 2 ? 3e-6 : 1e-7), `${name} channel ${channel} independent waveform error ${errors[channel]}`);
      assert.equal(actual[5].mean, Number(inverted), `${name} persistent source polarity`);
      for (let j = 0; j < parameterNames.length; j++) assert.equal(actual[6 + j].mean, expected[6 + j][0], `${name} rendered ${parameterNames[j]}`);
      checked.push({ name, maximumErrors: errors, samples: clock.length });
    };
    verify('identity', {}); verify('full', { amount: 1 }); verify('half', { amount: .5 });
    verify('sameInput', { amount: 1, samePattern: 1 });
    verify('capped', { amount: 1, samePattern: 1, carrierLevel: .125 });
    verify('silentModulator', { amount: 1, samePattern: 1, carrierLevel: .125, modulatorLevel: 0 });
    verify('silentCarrier', { amount: 1, samePattern: 1, carrierLevel: 0 });
    const saved = { amount: .75, carrierLevel: .5, modulatorLevel: 1, samePattern: 0, reset: 0, flip: 0 };
    verify('beforeSave', saved); verify('mutated', { ...saved, flip: 1 }, true);
    verify('controlsPrepared', saved, true); verify('afterRestore', saved); verify('restarted', saved);
    assert.equal(result.restored.ok, true);
    assert(phases.beforeSave[1].peak > .01 && phases.controlsPrepared[1].peak > .01, 'saved and mutated sources remain audibly nonzero');
    assert.equal(phases.silentModulator[1].peak, 0); assert.equal(phases.silentCarrier[0].peak, 0); assert.equal(phases.silentCarrier[1].peak, 0);
    assert(phases.reset.every(channel => channel.finite)); assert.equal(phases.reset[0].peak, 0); assert.equal(phases.reset[1].peak, 0); assert.equal(phases.reset[9].mean, 1);
    manifest.browserChecks = checked; manifest.checks.browser = 'PASS';
  } catch (error) { manifest.failure = String(error); throw error; }
  finally {
    writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await browser?.close(); if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
    rmSync(join(consumer, 'node_modules'), { recursive: true, force: true });
  }
});
