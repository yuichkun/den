import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '..');
const run = (command, args, cwd) => execFileSync(command, command === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('packed instrument module: isolated typecheck/offline render and real 48 kHz browser MIDI/parameters/reset', { timeout: 180000 }, async () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-instrument-'));
  cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
  cpSync(join(root, 'tests/instrument-consumer'), consumer, { recursive: true });
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  assert(pack.files.some(f => f.path === 'dist/instrument.d.ts'));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  run('npm', ['run', 'check'], consumer);
  run('node', ['render.mjs'], consumer);
  run('npm', ['run', 'build'], consumer);
  const { preview } = await import(pathToFileURL(join(consumer, 'node_modules/vite/dist/node/index.js')).href);
  const server = await preview({ root: consumer, configFile: false, preview: { host: '127.0.0.1', port: 0 } });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => typeof window.runInstrument === 'function');
    const result = await page.evaluate(() => window.runInstrument());
    assert.equal(result.sampleRate, 48000);
    for (const name of ['silent','bypassed','reset','ended','endedWhileBypassed']) assert.equal(result[name].peak, 0, name);
    for (const name of ['single','changed','filtered','resumed','chord','oneRelease','restarted']) {
      assert(result[name].finite, name); assert(result[name].rms > 0, name);
    }
    assert(Math.abs(result.changed.rms / result.single.rms - 0.5) < 0.03);
    assert(result.filtered.rms < result.changed.rms / 10);
    assert(Math.abs(result.resumed.rms / result.single.rms - 1) < 0.05);
    assert(Math.abs(result.chord.rms / result.single.rms - 2) < 0.1);
    assert(Math.abs(result.oneRelease.rms / result.single.rms - 1) < 0.05);
    const artifacts = join(root, 'artifacts/instrument'); mkdirSync(artifacts, { recursive: true });
    const files = {};
    for (const file of ['den.tgz', 'package-lock.json', 'instrument-evidence.json', ...[44100, 48000, 96000].flatMap(rate => [`instrument-${rate}.wav`, `instrument-${rate}.svg`])]) {
      copyFileSync(join(consumer, file), join(artifacts, file)); files[file] = hash(join(artifacts, file));
    }
    writeFileSync(join(artifacts, 'browser.json'), JSON.stringify(result, null, 2)); files['browser.json'] = hash(join(artifacts, 'browser.json'));
    const evidence = JSON.parse(readFileSync(join(consumer, 'instrument-evidence.json'), 'utf8'));
    writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify({
      ...evidence, sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(),
      sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '',
      sourceHashes: Object.fromEntries(['src/instrument.ts','src/instrument-example.ts','src/envelope.ts','src/lfo.ts','src/filter.ts','src/oscillator.ts','src/voice-policy.ts','tests/instrument.spec.ts','tests/instrument-packed.test.mjs','tests/instrument-consumer/processor.ts','tests/instrument-consumer/main.js','tests/instrument-consumer/render.mjs','package-lock.json'].map(file => [file,hash(join(root,file))])),
      unworklet:'0.4.1', channels:2, offlineSampleRates:[44100,48000,96000], browserSampleRates:[48000],
      verification:'Independent DSP and voice tests; packed TypeScript/build/offline render; browser MIDI, polyphony, release, gain/cutoff edits, bypass, reset',
      limitations:['Not human approved','Physical packed module import; public export pending integration','MIDI dispatch is quantum-boundary'],files,
    },null,2));
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  }
});
