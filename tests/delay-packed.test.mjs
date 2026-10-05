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

test('packed delay module: isolated typecheck/offline render and real 48 kHz browser reset', { timeout: 180000 }, async () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-delay-'));
  cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
  cpSync(join(root, 'tests/delay-consumer'), consumer, { recursive: true });
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  assert(pack.files.some(f => f.path === 'dist/delay-readhead.d.ts'));
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
    await page.waitForFunction(() => typeof window.runDelay === 'function');
    const result = await page.evaluate(() => window.runDelay());
    assert.equal(result.sampleRate, 48000);
    for (const [name, value] of [['initial', 0.75], ['cleared', 0], ['resumed', 0.75]]) {
      assert.equal(result[name].length, 256);
      assert(result[name].every(x => Math.abs(x - value) < 1e-6), name);
    }
    const artifacts = join(root, 'artifacts/delay'); mkdirSync(artifacts, { recursive: true });
    const files = {};
    for (const file of ['den.tgz', 'package-lock.json', ...[44100, 48000, 96000].flatMap(rate => [`delay-${rate}.wav`, `delay-${rate}.svg`])]) {
      copyFileSync(join(consumer, file), join(artifacts, file)); files[file] = hash(join(artifacts, file));
    }
    writeFileSync(join(artifacts, 'browser.json'), JSON.stringify(result, null, 2)); files['browser.json'] = hash(join(artifacts, 'browser.json'));
    writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(['src/delay-readhead.ts', 'tests/delay-readhead.spec.ts', 'tests/delay-packed.test.mjs', 'tests/delay-consumer/processor.ts', 'tests/delay-consumer/main.js', 'tests/delay-consumer/render.mjs', 'package-lock.json'].map(file => [file, hash(join(root, file))])), unworklet: '0.4.1', settings: { maxDelaySeconds: 8, interpolation: 'linear', transition: 'moving head', initialHistory: 'zero' }, parameters: { offlineDelaySamples: 2.5, reset: 0, browserDelaySamples: [2.5, 10.5], browserReset: [0, 1, 0] }, input: { offline: 'unit impulse at frame 0, 256 frames', browser: 'constant 0.75' }, midi: [], seed: null, preset: null, offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [48000], verification: 'Independent impulse weights, strict isolated consumer typecheck, browser output 0.75 → reset silence → 0.75', limitations: ['Not human approved', 'Public delay-readhead import; browser coverage is 48 kHz only'], files }, null, 2));
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  }
});
