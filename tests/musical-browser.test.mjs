import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { envelopeReference, waveReference } from './musical-controls-consumer/reference.mjs';

const root = join(import.meta.dirname, '..');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (command, args, cwd) => execFileSync(command, command === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args,
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });

test('packed curved ADSR and musical LFO: stage curves, native frequency, canonical seeks and guarded held-phase restore', { timeout: 180000 }, async () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-musical-browser-'));
  const artifacts = join(root, 'artifacts/musical-browser', new Date().toISOString().replaceAll(':', '-'));
  mkdirSync(artifacts, { recursive: true });
  const sourcePaths = ['package.json', 'package-lock.json', ...readdirSync(join(root, 'src')).filter(path => path.endsWith('.ts')).map(path => `src/${path}`),
    'tests/musical-browser.test.mjs', 'tests/musical-controls-consumer/reference.mjs',
    ...readdirSync(join(root, 'tests/musical-browser-consumer')).map(path => `tests/musical-browser-consumer/${path}`)];
  const manifest = { status: 'CANDIDATE', runtimeStatus: 'NOT_CLEARED', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(),
    sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sourcePaths.map(path => [path, hash(join(root, path))])), checks: {},
    consumerRetention: 'Only this newly created consumer dependency installation is removed; tarball, lock, fixtures, build and evidence remain',
    limitations: ['Small muted native 48 kHz control graph, not device or maximum-capacity deadline clearance',
      'ADSR curves are checked against a full repeating sample schedule identified by native frame telemetry',
      'Browser restore proves held nonzero LFO/clock state under already rendered saved controls; exact ADSR history remains independently proved offline',
      'No waveform bandlimit, host transport synchronization or new listening approval'] };
  let browser, server;
  try {
    cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
    cpSync(join(root, 'tests/musical-browser-consumer'), consumer, { recursive: true });
    copyFileSync(join(root, 'tests/musical-controls-consumer/reference.mjs'), join(consumer, 'reference.mjs'));
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
    manifest.checks.offline = 'PASS'; run('npm', ['run', 'build'], consumer); manifest.checks.build = 'PASS';
    manifest.wasm = Object.fromEntries(readdirSync(join(consumer, 'dist/assets')).filter(path => path.endsWith('.wasm')).map(path => [path, hash(join(consumer, 'dist/assets', path))]));
    const { preview } = await import(pathToFileURL(join(consumer, 'node_modules/vite/dist/node/index.js')).href);
    server = await preview({ root: consumer, configFile: false, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(); await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => typeof window.runMusical === 'function');
    const result = await page.evaluate(() => window.runMusical());
    writeFileSync(join(artifacts, 'browser.json'), JSON.stringify(result, null, 2));
    assert.equal(result.sampleRate, 48000); assert.deepEqual(result.errors.filter(error => error.code !== 'sab-unavailable'), []);
    const phases = result.phases, checks = [], phaseMaximum = 1 - 2 ** -24;
    const waveNames = ['sine', 'triangle', 'saw', 'square', 'sine'];
    const envTables = new Map();
    for (const bend of [.75, -.75, 0]) envTables.set(bend, envelopeReference(Array.from({ length: 1024 }, (_, frame) =>
      [+(frame >= 1 && frame <= 384), +(frame === 256), +(frame === 0), 64 / 48000, 96 / 48000, .375, 128 / 48000, bend, -bend, bend]), 48000));
    for (const [name, data] of Object.entries(phases)) {
      assert.equal(data.length, 23); assert(data.every(channel => channel.finite), `${name} finite`);
      const clear = name === 'reset', bend = data[22].mean;
      for (let n = 0; n < 2048; n++) {
        const frame = data[2].samples[n];
        assert(Number.isInteger(frame) && frame >= 0 && frame < 1024);
        if (clear) { assert.equal(frame, 0); assert.equal(data[0].samples[n], 0); assert.equal(data[1].samples[n], 1); }
        else {
          if (n) assert.equal(frame, (data[2].samples[n - 1] + 1) % 1024, `${name} frame progression`);
          assert(envTables.has(bend), `${name} settled bend`);
          const expected = envTables.get(bend)[frame];
          assert(Math.abs(data[0].samples[n] - expected[0]) < 2e-7, `${name} curved segment at frame ${frame}`);
          assert.equal(data[1].samples[n], expected[1], `${name} exact segment done at frame ${frame}`);
        }
        for (let w = 0; w < 5; w++) {
          const channel = 3 + 2 * w, phase = data[channel + 1].samples[n];
          assert(phase >= 0 && phase < 1, `${name} canonical phase`);
          assert(Math.abs(data[channel].samples[n] - waveReference(waveNames[w], phase)) < 2e-7, `${name} ${waveNames[w]} waveform`);
          if (w > 0 && w < 4) assert.equal(phase, data[4].samples[n], `${name} shared free frequency`);
        }
      }
      if (['steady', 'edited', 'linear', 'resumed'].includes(name)) {
        for (const [channel, frequency] of [[4, data[15].mean], [12, data[16].mean / 30]]) {
          let maximumError = 0;
          for (let n = 1; n < 2048; n++) {
            const delta = (data[channel].samples[n] - data[channel].samples[n - 1] + 1) % 1;
            maximumError = Math.max(maximumError, Math.abs(delta - frequency / 48000));
          }
          assert(maximumError < 1.3e-7, `${name} phase increment at ${frequency} Hz`);
          checks.push({ name, channel, frequency, maximumError });
        }
      }
    }
    for (const [name, position, offset] of [['prepareSavedSeek', .375, .125], ['prepareMutatedSeek', -.25, .125], ['prepareTinySeek', -(2 ** -60), 0]]) {
      for (const [channel, expected] of [[17, 1], [18, 0], [19, position], [20, offset], [21, 0]])
        assert.equal(phases[name][channel].mean, expected, `${name} rendered controls before seek edge ${channel}`);
    }
    assert(phases.prepareMutatedSeek[4].samples.every(p => p === .5), 'preparing a new seek position must not change held phase');
    assert(phases.prepareTinySeek[4].samples.every(p => p === .375), 'zero offset removes only offset before tiny seek');
    for (const name of ['beforeSave', 'controlsPrepared', 'afterRestore']) {
      for (const [channel, expected] of [[15, 6.25], [16, 180], [17, 1], [18, 0], [19, .375], [20, .125], [21, 0], [22, 0]])
        assert.equal(phases[name][channel].mean, expected, `${name} rendered saved control ${channel}`);
    }
    for (const name of ['beforeSave', 'afterRestore']) {
      for (const channel of [4, 6, 8, 10, 12]) assert(phases[name][channel].samples.every(p => p === .5), `${name} exact held phase`);
      assert.equal(phases[name][13].mean, 0); assert.equal(phases[name][14].mean, .375);
    }
    for (const name of ['mutated', 'controlsPrepared']) {
      for (const channel of [4, 6, 8, 10, 12]) assert(phases[name][channel].samples.every(p => p === .875), `${name} unequal held phase`);
      assert.equal(phases[name][13].mean, 2); assert.equal(phases[name][14].mean, .75);
    }
    assert.equal(result.restored.ok, true);
    for (const name of ['tinyNegative', 'tinyHeld']) {
      for (const channel of [4, 6, 8, 10, 12]) assert(phases[name][channel].samples.every(p => p === phaseMaximum), `${name} negative tiny seek remains below upper endpoint`);
      assert.equal(phases[name][13].mean, 2); assert.equal(phases[name][14].mean, phaseMaximum);
    }
    for (const channel of [4, 6, 8, 10, 12]) assert(phases.reset[channel].samples.every(p => p === .125));
    assert.equal(phases.reset[13].mean, 0); assert.equal(phases.reset[14].mean, 0);
    manifest.browserChecks = checks; manifest.checks.browser = 'PASS';
  } catch (error) { manifest.failure = String(error); throw error; }
  finally {
    writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await browser?.close(); if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
    rmSync(join(consumer, 'node_modules'), { recursive: true, force: true });
  }
});
