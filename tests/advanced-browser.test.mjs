import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const root = join(import.meta.dirname, '..'), hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const run = (cmd, args, cwd) => execFileSync(cmd, cmd === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
const near = (actual, expected, label, tolerance = 2e-5) => assert(Math.abs(actual - expected) < tolerance, `${label}: ${actual} versus ${expected}`);
const add = (a, b) => [a[0] + b[0], a[1] + b[1]], mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const scale = (a, b) => a.map(x => x * b), div = (a, b) => scale(mul(a, [b[0], -b[1]]), 1 / (b[0] ** 2 + b[1] ** 2));
function lrAllpass(cutoff, hz, rate) {
  const w = 2 * Math.PI * cutoff / rate, a = Math.sin(w) / Math.SQRT2;
  const z = [Math.cos(2 * Math.PI * hz / rate), -Math.sin(2 * Math.PI * hz / rate)], z2 = mul(z, z);
  const denominator = add(add([1 + a, 0], scale(z, -2 * Math.cos(w))), scale(z2, 1 - a));
  const low = div(scale(add(add([1, 0], scale(z, 2)), z2), (1 - Math.cos(w)) / 2), denominator);
  const high = div(scale(add(add([1, 0], scale(z, -2)), z2), (1 + Math.cos(w)) / 2), denominator);
  return add(mul(low, low), mul(high, high));
}

test('packed frequency shift, lookahead ceiling and phase-compensated dynamics in actual 48 kHz worklet', { timeout: 180000 }, async () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-advanced-browser-')), artifacts = join(root, 'artifacts/advanced-browser', new Date().toISOString().replaceAll(':', '-'));
  mkdirSync(artifacts, { recursive: true });
  const files = ['package.json', 'package-lock.json', ...readdirSync(join(root, 'src')).filter(x => x.endsWith('.ts')).map(x => `src/${x}`), 'tests/advanced-browser.test.mjs', ...readdirSync(join(root, 'tests/advanced-browser-consumer')).map(x => `tests/advanced-browser-consumer/${x}`)];
  const manifest = { status: 'CANDIDATE', runtimeStatus: 'NOT_CLEARED', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(files.map(x => [x, hash(join(root, x))])), checks: {}, limitations: ['Functional browser graph, not a deadline or device certificate', 'Limiter is sample-peak only', 'Hilbert rejection applies only to the documented translated-frequency band', 'Static multiband sum is an allpass product, not original PCM or a modulation-flat claim', 'Exact delay and state continuity are tested independently offline; browser snapshot checks parameter restoration'] };
  let server, browser;
  try {
    cpSync(join(root, 'tests/consumer'), consumer, { recursive: true }); cpSync(join(root, 'tests/advanced-browser-consumer'), consumer, { recursive: true });
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
    const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root)); copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8')); lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity; writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock)); manifest.packageIntegrity = pack.integrity;
    run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer); run('npm', ['run', 'check'], consumer); manifest.checks.publicTypes = 'PASS';
    writeFileSync(join(consumer, 'oracle.mjs'), `import assert from'node:assert/strict';import{renderOffline}from'@unworklet/offline';import processor from'./processor.ts';for(const sampleRate of[44100,48000,96000]){const r=await renderOffline(processor,{sampleRate,duration:.1});assert.equal(r.diagnostics.scrubbedSamples,0);for(const ch of r.outputs.main)assert(ch.every(Number.isFinite));for(let n=1024;n<r.outputs.main[0].length;n++){const c=r.outputs.main[4][n];assert(Math.abs(c-10**(-6/20))<c*8e-6);assert(Math.abs(r.outputs.main[2][n]-c)<1e-7);assert(Math.abs(r.outputs.main[3][n]+c/2)<1e-7);assert(Math.abs(r.outputs.main[5][n]-r.outputs.main[7][n])<2e-6);assert(Math.abs(r.outputs.main[6][n]+r.outputs.main[5][n]/2)<2e-6);}}console.log('Three-rate bounded advanced composition passed');`);
    run('node', ['oracle.mjs'], consumer); manifest.checks.offlineComposition = 'PASS'; run('npm', ['run', 'build'], consumer); manifest.checks.build = 'PASS';
    manifest.wasm = Object.fromEntries(readdirSync(join(consumer, 'dist/assets')).filter(x => x.endsWith('.wasm')).map(x => [x, hash(join(consumer, 'dist/assets', x))]));
    const { preview } = await import(pathToFileURL(join(consumer, 'node_modules/vite/dist/node/index.js')).href); server = await preview({ root: consumer, configFile: false, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(); await page.goto(server.resolvedUrls.local[0]); await page.waitForFunction(() => typeof window.runAdvanced === 'function');
    const result = await page.evaluate(() => window.runAdvanced()); writeFileSync(join(artifacts, 'browser.json'), JSON.stringify(result, null, 2));
    assert.equal(result.sampleRate, 48000); assert.equal(result.restored.ok, true); assert.deepEqual(result.errors.filter(x => x.code !== 'sab-unavailable'), []);
    for (const name of ['initial', 'edited', 'bypassed', 'afterRestore', 'reset']) assert(result[name].every(x => x.finite));
    const transfer = mul(lrAllpass(1000, 6000, 48000), lrAllpass(4000, 6000, 48000));
    for (const [name, db] of [['initial', -6], ['edited', -12], ['bypassed', -12], ['afterRestore', -6]]) {
      const state = result[name], ceiling = state[4].mean;
      assert(Math.abs(ceiling - 10 ** (db / 20)) < ceiling * 8e-6, `${name} dB ceiling conversion`);
      near(state[2].mean, ceiling, `${name} linked left ceiling`, 1e-7); near(state[3].mean, -.5 * ceiling, `${name} linked right`, 1e-7);
      near(state[0].bins[32].amplitude, .125, `${name} source frequency`);
      const expected = mul(transfer, [state[0].bins[32].re, state[0].bins[32].im]);
      near(state[7].bins[32].re, expected[0], `${name} allpass real`); near(state[7].bins[32].im, expected[1], `${name} allpass imaginary`);
    }
    for (const name of ['initial', 'afterRestore']) {
      const state = result[name]; near(state[1].bins[36].amplitude, .125, `${name} upper shift`); assert(state[1].bins[28].amplitude < state[1].bins[36].amplitude * 10 ** (-70 / 20));
      near(state[5].bins[32].re, state[7].bins[32].re, `${name} unity band real`); near(state[5].bins[32].im, state[7].bins[32].im, `${name} unity band imaginary`);
      const averaged = mul([.5 * (1 + Math.SQRT1_2), -.5 * Math.SQRT1_2], [state[0].bins[32].re, state[0].bins[32].im]);
      near(state[8].bins[32].re, averaged[0], `${name} identity curve half-sample real`); near(state[8].bins[32].im, averaged[1], `${name} identity curve half-sample imaginary`); near(state[8].mean, 0, `${name} identity curve zero DC`);
      near(state[6].bins[32].re, -.5 * state[5].bins[32].re, `${name} right real`); near(state[6].bins[32].im, -.5 * state[5].bins[32].im, `${name} right imaginary`);
    }
    near(result.edited[1].bins[28].amplitude, .125, 'lower shift'); assert(result.edited[1].bins[36].amplitude < result.edited[1].bins[28].amplitude * 10 ** (-70 / 20));
    near(result.bypassed[1].bins[32].amplitude, .125, 'latency-aligned bypass frequency'); assert(result.bypassed[1].bins[28].amplitude < 1e-6 && result.bypassed[1].bins[36].amplitude < 1e-6);
    for (const name of ['edited', 'bypassed']) { assert(result[name][5].rms < 1e-4 && result[name][6].rms < 1e-4, `${name} compression controls changed wet output`);
      // For x=.125*sin(2*pi*n/8), the current curve is x+.5*(1-|x|).
      // Its interval mean preserves the eight-sample mean absolute value.
      near(result[name][8].mean, .5 * (1 - .125 * (1 + Math.SQRT2) / 4), `${name} native ordinate edit`); }
    for (const ch of [0, 1, 2, 3, 5, 6, 7, 8]) assert.equal(result.reset[ch].peak, 0, `held reset channel${ch}`);
    manifest.checks.browserAdvanced = 'PASS';
  } catch (error) { manifest.failure = String(error); throw error; }
  finally { writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2)); await browser?.close(); if (server) await new Promise((yes, no) => server.httpServer.close(error => error ? no(error) : yes())); }
});
