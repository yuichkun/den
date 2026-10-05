import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const root = join(import.meta.dirname, '..');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (command, args, cwd) => execFileSync(command, command === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
const near = (actual, expected, message) => assert(Math.abs(actual - expected) < 2e-5, `${message}: ${actual} versus ${expected}`);

test('packed source/control candidates in actual 48 kHz worklets', { timeout: 180000 }, async () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-source-control-browser-'));
  const artifacts = join(root, 'artifacts/source-control-browser', new Date().toISOString().replaceAll(':', '-'));
  mkdirSync(artifacts, { recursive: true });
  const files = ['package.json', 'package-lock.json', ...readdirSync(join(root, 'src')).filter(f => f.endsWith('.ts')).map(f => `src/${f}`), 'tests/source-control-browser.test.mjs', ...readdirSync(join(root, 'tests/source-control-browser-consumer')).map(f => `tests/source-control-browser-consumer/${f}`)];
  const manifest = { status: 'CANDIDATE', runtimeStatus: 'NOT_CLEARED', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(files.map(f => [f, hash(join(root, f))])), checks: {}, limitations: ['Small functional browser graph, not maximum-capacity deadline certification', 'Native MIDI output is tested offline separately; external host/device delivery is unverified', 'No human sound approval'] };
  let browser, server;
  try {
    cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
    cpSync(join(root, 'tests/source-control-browser-consumer'), consumer, { recursive: true });
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['source-processor.ts', 'control-processor.ts'] }));
    const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
    copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
    writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock)); manifest.packageIntegrity = pack.integrity;
    run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer); run('npm', ['run', 'check'], consumer); manifest.checks.publicTypes = 'PASS';
    // Check finite output and independent stopped-control constants before the browser.
    // The source RMS/DC assertions below apply to the actual 48 kHz browser output.
    writeFileSync(join(consumer, 'oracle.mjs'), `import assert from 'node:assert/strict';import{renderOffline}from'@unworklet/offline';import source from'./source-processor.ts';import control from'./control-processor.ts';
for(const sampleRate of[44100,48000,96000]){for(const processor of[source,control]){const r=await renderOffline(processor,{sampleRate,duration:.2});assert.equal(r.diagnostics.scrubbedSamples,0);for(const ch of r.outputs.main)assert(ch.every(Number.isFinite));if(processor===control){for(const[ch,value]of[[0,0],[1,0],[2,.25],[3,1],[4,-1],[5,.25]])for(const x of r.outputs.main[ch].subarray(256))assert(Math.abs(x-value)<2e-5);}}}console.log('Three-rate small graph and stopped-control oracle passed');`);
    run('node', ['oracle.mjs'], consumer); manifest.checks.offline = 'PASS';
    run('npm', ['run', 'build'], consumer); manifest.checks.build = 'PASS';
    manifest.wasm = Object.fromEntries(readdirSync(join(consumer, 'dist/assets')).filter(f => f.endsWith('.wasm')).map(f => [f, hash(join(consumer, 'dist/assets', f))]));
    const { preview } = await import(pathToFileURL(join(consumer, 'node_modules/vite/dist/node/index.js')).href);
    server = await preview({ root: consumer, configFile: false, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(); await page.goto(server.resolvedUrls.local[0]); await page.waitForFunction(() => typeof window.runSources === 'function');
    const source = await page.evaluate(() => window.runSources()), control = await page.evaluate(() => window.runControls());
    writeFileSync(join(artifacts, 'browser.json'), JSON.stringify({ source, control }, null, 2));
    for (const result of [source, control]) {
      assert.equal(result.sampleRate, 48000); assert.equal(result.restored.ok, true);
      for (const key of ['initial', 'edited', 'afterRestore', 'reset']) assert(result[key].every(x => x.finite));
      assert.deepEqual(result.errors.filter(x => x.code !== 'sab-unavailable'), []);
    }
    const modalDc = [1000, 2000].reduce((sum, hz, i) => { const w = 2 * Math.PI * hz / 48000, r = Math.exp(-Math.LN10 * 3 / (.05 * 48000)); return sum + (.01 * Math.sin(w) / (1 - 2 * r * Math.cos(w) + r * r)) * (i ? 1 / 3 : 2 / 3); }, 0);
    for (const key of ['initial', 'edited', 'afterRestore']) {
      for (const [ch, rms] of [[0, Math.SQRT1_2], [1, Math.SQRT1_2], [2, Math.sqrt(5 / 18)], [3, Math.sqrt(1 / 8)], [4, Math.sqrt(1 / 8)]]) near(source[key][ch].rms, rms, `source ${key} RMS channel ${ch}`);
      near(source[key][5].mean, modalDc, `source ${key} modal DC`); near(source[key][6].mean, .01, `source ${key} comb DC`);
    }
    for (const ch of [0, 1]) {
      for (const key of ['initial', 'afterRestore']) { near(source[key][ch].bin2, 1, `375 Hz ${key}`); near(source[key][ch].bin4, 0, `no 750 Hz ${key}`); }
      near(source.edited[ch].bin4, 1, '750 Hz edit'); near(source.edited[ch].bin2, 0, 'no 375 Hz after edit');
    }
    assert.equal(source.historyRestored.ok, true);
    assert(Math.abs(source.held[0].mean) > .1, 'history fixture must differ from a zero-phase restart');
    for (const key of ['held', 'cleared', 'restarted', 'recovered']) assert(source[key].every(x => x.finite));
    for (let ch = 0; ch < 5; ch++) {
      near(source.restarted[ch].peak, 0, `restart phase ${ch}`);
      near(source.recovered[ch].mean, source.held[ch].mean, `restored held phase ${ch}`);
    }
    assert(source.cleared.every(x => x.peak === 0)); assert(source.reset.every(x => x.peak === 0));
    for (const [key, expected] of [['initial', [0, 0, .25, 1, -1, .25]], ['prepared', [2, .5, .75, 1, 1, .75]], ['afterRestore', [2, .5, .75, 1, 1, .75]], ['edited', [1, .25, .5, 1, 1, -.5]], ['reset', [0, 0, .25, 0, -1, 0]]]) {
      assert(control[key].every(x => x.finite)); expected.forEach((x, ch) => near(control[key][ch].mean, x, `control ${key} channel ${ch}`)); assert(control[key][6].peak <= 1);
    }
    let seed = 19n, value = .25; const random = [];
    for (let n = 0; n < 3; n++) { seed = seed * 16807n % 2147483647n; value = .5 * value + .5 * (2 * (Number(seed) - 1) / 2147483645 - 1); random.push(value); }
    near(control.initial[6].mean, random[0], 'first random update'); near(control.prepared[6].mean, random[1], 'second random update');
    near(control.edited[6].mean, random[2], 'third random update'); near(control.afterRestore[6].mean, random[1], 'noninitial random snapshot'); near(control.reset[6].mean, .25, 'random reset');
    manifest.checks.browserSources = 'PASS'; manifest.checks.browserControls = 'PASS';
  } catch (error) { manifest.failure = String(error); throw error; }
  finally { writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2)); await browser?.close(); if (server) await new Promise((yes, no) => server.httpServer.close(error => error ? no(error) : yes())); }
});
