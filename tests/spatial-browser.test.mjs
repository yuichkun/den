import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { componentTransfer, predictedTransfer, observedBin, mul, scale, sub, abs } from './spatial-browser-consumer/transfer.mjs';

const root = join(import.meta.dirname, '..');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (command, args, cwd) => execFileSync(command, command === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args,
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });

test('packed hybrid and feedforward space: complex transfer, coherent pitch and guarded nonzero tail restore in browser', { timeout: 180000 }, async () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-spatial-browser-'));
  const artifacts = join(root, 'artifacts/spatial-browser', new Date().toISOString().replaceAll(':', '-'));
  mkdirSync(artifacts, { recursive: true });
  const sourcePaths = ['package.json', 'package-lock.json', ...readdirSync(join(root, 'src')).filter(path => path.endsWith('.ts')).map(path => `src/${path}`),
    'tests/spatial-browser.test.mjs', 'tests/fixtures/spatial-chains-reference.ts', 'tests/fixtures/windowed-pitch-shift-reference.ts',
    ...readdirSync(join(root, 'tests/spatial-browser-consumer')).map(path => `tests/spatial-browser-consumer/${path}`)];
  const manifest = { status: 'CANDIDATE', runtimeStatus: 'NOT_CLEARED', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(),
    sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sourcePaths.map(path => [path, hash(join(root, path))])), checks: {},
    consumerRetention: 'Only this newly created consumer dependency installation is removed; tarball, lock, fixtures, build and evidence remain',
    limitations: ['Small muted 48 kHz composition, not device or maximum-capacity deadline clearance',
      'Independent complex transfer applies to linear steady unity-ratio paths; shifted tests use specifically coherent tones',
      'Half-rate interpolation loss is included; arbitrary pitch phase, coloration and cancellation are not waived',
      'All saved controls render while unequal histories remain before native restore; raw state/AudioParam restoration is not atomic',
      'Paired nonzero tail recovery is a browser functional state check; exact waveform continuation remains separately proved offline',
      'Feedforward pitch is outside FDN feedback and is not regenerative shimmer'] };
  let browser, server;
  try {
    cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
    cpSync(join(root, 'tests/spatial-browser-consumer'), consumer, { recursive: true });
    writeFileSync(join(consumer, 'reference.ts'), readFileSync(join(root, 'tests/fixtures/spatial-chains-reference.ts'), 'utf8').replace('./windowed-pitch-shift-reference.js', './pitch-reference.ts'));
    copyFileSync(join(root, 'tests/fixtures/windowed-pitch-shift-reference.ts'), join(consumer, 'pitch-reference.ts'));
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
    await page.waitForFunction(() => typeof window.runSpatial === 'function');
    const result = await page.evaluate(() => window.runSpatial());
    writeFileSync(join(artifacts, 'browser.json'), JSON.stringify(result, null, 2));
    assert.equal(result.sampleRate, 48000); assert.deepEqual(result.errors.filter(error => error.code !== 'sab-unavailable'), []);
    const phases = result.phases, omega = 2 * Math.PI / 128, inputBin = [0, -.25], checks = [];
    for (const [name, data] of Object.entries(phases)) {
      assert.equal(data.length, 19); assert(data.every(channel => channel.finite), `${name} finite`);
      if (name === 'resetBypass') continue;
      const clock = data[7].samples;
      for (let n = 0; n < clock.length; n++) {
        assert(Number.isInteger(clock[n]) && clock[n] >= 0 && clock[n] < 256);
        if (n) assert.equal(clock[n], (clock[n - 1] + 1) % 256, `${name} native phase progression`);
        assert(Math.abs(data[6].samples[n] - Math.sin(omega * clock[n]) * data[11].mean) < 2e-7, `${name} known native source`);
      }
      assert.equal(data[10].mean, 0, `${name} accepted ratio`);
    }
    const complexCheck = (name, channel, expected, multiplier = 1) => {
      const data = phases[name], actual = observedBin(data[channel].samples, data[7].samples, multiplier), error = abs(sub(actual, expected));
      assert(error < 5e-6, `${name} channel ${channel} complex error ${error}`); checks.push({ name, channel, multiplier, actual, expected, error });
    };
    const steady = (name, mix, pitchMix) => {
      const h = predictedTransfer(48000, omega, mix, pitchMix, 2048, false);
      const p = predictedTransfer(48000, omega, mix, pitchMix, 2048, true);
      for (let ch = 0; ch < 2; ch++) { complexCheck(name, ch, mul(h[ch], inputBin)); complexCheck(name, ch + 2, mul(p[ch], inputBin)); complexCheck(name, ch + 4, mul(p[ch], inputBin)); }
    };
    steady('steady', 1, .5); steady('dry', 0, .5); steady('unpitched', 1, 0); steady('unityLate', 1, 1);
    steady('rephase', 1, 1); steady('restoredUnity', 1, .5);
    for (const name of ['dry', 'bypass', 'bypassAfterReset']) for (let ch = 0; ch < 6; ch++) {
      assert.deepEqual(phases[name][ch].samples, phases[name][6].samples, `${name} unity dry channel ${ch}`);
    }
    for (let n = 0; n < 2048; n++) for (let ch = 0; ch < 2; ch++) assert.equal(phases.unpitched[ch].samples[n], phases.unpitched[ch + 2].samples[n]);
    const { early, late } = componentTransfer(48000, omega);
    for (const [name, ratio] of [['octave', 2], ['half', .5]]) {
      for (let ch = 0; ch < 2; ch++) {
        complexCheck(name, ch, mul(predictedTransfer(48000, omega, 1, 1, 2048, false)[ch], inputBin));
        // With W2048, head separation1024 is eight input periods. Half speed
        // alternates integer/half-sample reads; its fundamental gain is cos²(w/4).
        const interpolation = ratio === .5 ? Math.cos(omega / 4) ** 2 : 1;
        const expected = .125 * abs(late[ch]) * interpolation;
        assert(expected > .001, 'shifted probe must be nontrivial');
        for (const channel of [ch + 2, ch + 4]) {
          complexCheck(name, channel, mul(scale(early[ch], .5), inputBin));
          const actual = abs(observedBin(phases[name][channel].samples, phases[name][7].samples, ratio));
          assert(Math.abs(actual - expected) < 5e-6, `${name} channel ${channel} coherent shifted magnitude ${actual} vs ${expected}`);
          checks.push({ name, channel, ratio, actualShiftedMagnitude: actual, expectedShiftedMagnitude: expected });
        }
      }
    }
    for (const name of ['beforeSave', 'controlsPrepared', 'afterRestore']) {
      const data = phases[name];
      for (const [channel, expected] of [[11, 0], [12, 1], [13, 0], [14, 0], [15, 1], [16, .5], [17, 0], [18, 0]]) assert.equal(data[channel].mean, expected, `${name} rendered saved control ${channel}`);
    }
    for (const name of ['beforeSave', 'afterRestore']) {
      assert.equal(phases[name][8].peak, 0, `${name} exact paired left`); assert.equal(phases[name][9].peak, 0, `${name} exact paired right`);
      assert(phases[name][2].rms + phases[name][3].rms > 1e-6, `${name} nonzero tail`);
    }
    assert(phases.mutated[8].peak > 1e-5 || phases.mutated[9].peak > 1e-5);
    assert(phases.controlsPrepared[8].peak > 1e-5 || phases.controlsPrepared[9].peak > 1e-5, 'rendering saved controls must retain genuinely different histories');
    assert.equal(result.restored.ok, true);
    assert.equal(phases.resetBypass[13].mean, 1); assert.equal(phases.resetBypass[14].mean, 1);
    for (const name of ['resetBypass', 'empty']) for (let ch = 0; ch < 6; ch++) assert.equal(phases[name][ch].peak, 0, `${name} channel ${ch} silent`);
    manifest.browserChecks = checks; manifest.checks.browser = 'PASS';
  } catch (error) { manifest.failure = String(error); throw error; }
  finally {
    writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await browser?.close(); if (server) await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
    rmSync(join(consumer, 'node_modules'), { recursive: true, force: true });
  }
});
