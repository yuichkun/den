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
const run = (cmd, args, cwd) => execFileSync(cmd, cmd === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
const near = (actual, expected, label) => assert(Math.abs(actual - expected) < 2e-6, `${label}: ${actual} versus ${expected}`);

test('packed resident PCM and small spectral graph in an actual 48 kHz worklet', { timeout: 180000 }, async () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-materials-browser-'));
  const artifacts = join(root, 'artifacts/materials-browser', new Date().toISOString().replaceAll(':', '-'));
  mkdirSync(artifacts, { recursive: true });
  const files = ['package.json', 'package-lock.json', ...readdirSync(join(root, 'src')).filter(f => f.endsWith('.ts')).map(f => `src/${f}`), 'tests/materials-browser.test.mjs', 'tests/performance-consumer/processor.ts', ...readdirSync(join(root, 'tests/materials-browser-consumer')).map(f => `tests/materials-browser-consumer/${f}`)];
  const manifest = { status: 'CANDIDATE', runtimeStatus: 'NOT_CLEARED', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(files.map(f => [f, hash(join(root, f))])), checks: {}, settings: { sampleCapacity: 256, eventCapacity: 16, payloadBytes: 1024, grains: 2, stftSize: 8, hopSize: 4, convolutionBlockSize: 4, impulse: [.5, -.25, .25] }, limitations: ['Small functional browser composition, not maximum-capacity or deadline certification', 'Native PCM messages dispatch at process boundaries; preload before audible use', 'Spectral latency and sample-accurate history continuation are proved by separate offline oracles', 'No human sound approval'] };
  let browser, server;
  try {
    cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
    cpSync(join(root, 'tests/materials-browser-consumer'), consumer, { recursive: true });
    copyFileSync(join(root, 'tests/performance-consumer/processor.ts'), join(consumer, 'performance-fixture.ts'));
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, allowImportingTsExtensions: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts', 'performance-processor.ts', 'performance-fixture.ts', 'wave-processor.ts'] }));
    const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
    copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
    writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock)); manifest.packageIntegrity = pack.integrity;
    run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer); run('npm', ['run', 'check'], consumer); manifest.checks.publicTypes = 'PASS';
    writeFileSync(join(consumer, 'oracle.mjs'), `import assert from 'node:assert/strict';import{renderOffline}from'@unworklet/offline';import processor from'./processor.ts';
const pcm=Float32Array.from({length:64},(_,n)=>.25+.125*Math.sin(2*Math.PI*n/64)),ir=[.5,-.25,.25],frames=2048;
for(const sampleRate of[44100,48000,96000]){const r=await renderOffline(processor,{sampleRate,duration:(frames-.25)/sampleRate,messages:[{name:'load',payload:{data:pcm}}]});assert.equal(r.diagnostics.scrubbedSamples,0);for(const ch of r.outputs.main)assert(ch.every(Number.isFinite));for(let n=0;n<frames;n++){const expected=[pcm[n%64],n<8?0:pcm[(n-8)%64],ir.reduce((sum,c,k)=>sum+(n-4-k>=0?c*pcm[(n-4-k)%64]:0),0)];for(let ch=0;ch<3;ch++)assert(Math.abs(r.outputs.main[ch][n]-expected[ch])<2e-6,'composed rate='+sampleRate+' ch='+ch+' n='+n);assert.equal(r.outputs.main[4][n],64);assert.equal(r.outputs.main[6][n],n%64);}assert.equal(Math.max(...r.outputs.main[5]),2);assert(Math.max(...r.outputs.main[3].map(Math.abs))<=.375001);}console.log('Three-rate sample→STFT/FIR composition oracle passed');`);
    run('node', ['oracle.mjs'], consumer); manifest.checks.offlineComposition = 'PASS';
    run('npm', ['run', 'build'], consumer); manifest.checks.build = 'PASS';
    manifest.wasm = Object.fromEntries(readdirSync(join(consumer, 'dist/assets')).filter(f => f.endsWith('.wasm')).map(f => [f, hash(join(consumer, 'dist/assets', f))]));
    const { preview } = await import(pathToFileURL(join(consumer, 'node_modules/vite/dist/node/index.js')).href);
    server = await preview({ root: consumer, configFile: false, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(); await page.goto(server.resolvedUrls.local[0]); await page.waitForFunction(() => typeof window.runMaterials === 'function');
    const result = await page.evaluate(() => window.runMaterials());
    writeFileSync(join(artifacts, 'browser.json'), JSON.stringify(result, null, 2));
    assert.equal(result.sampleRate, 48000); assert.equal(result.restored.ok, true);
    const states = [result.unloaded, result.first.loaded, result.first.playing, result.short.loaded, result.short.playing, result.empty.loaded, result.empty.playing, result.recovered, result.reset];
    assert(states.every(state => state.every(x => x.finite)));
    assert.deepEqual(result.errors.filter(x => x.code !== 'sab-unavailable'), []);
    assert(result.unloaded.every(x => x.peak === 0));
    for (const [name, state, length] of [['first', result.first.loaded, 64], ['short', result.short.loaded, 1], ['empty', result.empty.loaded, 0]]) {
      near(state[4].mean, length, `${name} native loaded length`);
      for (const ch of [0, 1, 2, 3, 5]) near(state[ch].peak, 0, `${name} before gate`);
    }
    for (const [name, state, value, length] of [['first', result.first.playing, .25, 64], ['short', result.short.playing, -.125, 1], ['restored', result.recovered, .25, 64]]) {
      near(state[0].mean, value, `${name} sample PCM`); near(state[1].mean, value, `${name} STFT DC`); near(state[2].mean, value * .5, `${name} convolution DC`);
      near(state[4].mean, length, `${name} resident length`); near(state[5].peak, 2, `${name} active grain capacity`);
      state[0].samples.forEach((sample, n) => near(sample, length === 64 ? .25 + .125 * Math.sin(2 * Math.PI * state[6].samples[n] / 64) : value, `${name} PCM order at ${n}`));
      assert(state[3].rms > .005 && state[3].peak <= (length === 64 ? .375 : Math.abs(value)) + 2e-6, `${name} bounded grains`);
    }
    assert(result.empty.playing.every(x => x.peak === 0));
    for (const ch of [0, 1, 2, 3, 5]) near(result.reset[ch].peak, 0, `held reset channel ${ch}`);
    near(result.reset[4].mean, 64, 'DSP reset keeps resident PCM');
    manifest.checks.nativePcmLifecycle = 'PASS'; manifest.checks.browserSmallSpectralComposition = 'PASS';
    const performance = await page.evaluate(() => window.runPerformance());
    writeFileSync(join(artifacts, 'browser-performance.json'), JSON.stringify(performance, null, 2));
    assert.equal(performance.sampleRate, 48000); assert.equal(performance.restored.ok, true);
    assert.deepEqual(performance.errors.filter(x => x.code !== 'sab-unavailable'), []);
    for (const key of ['initial', 'single', 'retuned', 'expressive', 'sustained', 'released', 'afterRestore', 'controllerReset', 'panic']) assert(performance[key].every(x => x.finite));
    for (const key of ['initial', 'released', 'afterRestore', 'panic']) assert(performance[key].every(x => x.peak === 0), `${key} does not reintroduce held notes/tails`);
    for (const key of ['single', 'controllerReset']) {
      near(performance[key][0].bin2, .25, `${key} 375 Hz audio`); near(performance[key][0].bin4, 0, `${key} no750Hz`);
      near(performance[key][1].mean, 375, `${key} frequency`); near(performance[key][2].mean, .25, `${key} neutral expression level`);
    }
    near(performance.retuned[0].bin4, .25, '750Hz parameter edit'); near(performance.retuned[0].bin2, 0, 'retuned no375Hz'); near(performance.retuned[1].mean, 750, 'retuned frequency');
    for (const key of ['expressive', 'sustained']) {
      assert(Math.abs(performance[key][1].mean - 375 * 2 ** (2 / 12)) < 5e-5, `${key} full pitch bend`);
      near(performance[key][2].mean, 1, `${key} pressure/timbre level`); assert(performance[key][0].peak > .9 && performance[key][0].peak <= 1.000002);
    }
    manifest.checks.browserPerformance = 'PASS';
    const waves = await page.evaluate(() => window.runWaves()); writeFileSync(join(artifacts, 'browser-waves.json'), JSON.stringify(waves, null, 2));
    assert.equal(waves.sampleRate, 48000); assert.equal(waves.restored.ok, true); assert.deepEqual(waves.errors.filter(x => x.code !== 'sab-unavailable'), []);
    for (const key of ['missing', 'loaded', 'edited', 'short', 'recovered', 'reset']) assert(waves[key].every(x => x.finite));
    for (const key of ['missing', 'short']) { near(waves[key][0].peak, 0, `${key} wavetable`); near(waves[key][1].mean, 1, `${key} missing flag`); }
    for (const key of ['loaded', 'recovered']) { near(waves[key][0].mean, .25, `${key} table DC`); near(waves[key][0].bin4, .125, `${key} table 750Hz`); near(waves[key][0].bin8, 0, `${key} table no1500Hz`); near(waves[key][1].mean, 0, `${key} complete asset`); }
    near(waves.edited[0].bin8, .125, 'table 1500Hz edit'); near(waves.edited[0].bin4, 0, 'table no750Hz after edit');
    for (const [key, bin, step] of [['loaded', 'bin4', 1 / 64], ['edited', 'bin8', 1 / 32], ['recovered', 'bin4', 1 / 64]]) {
      // These integer periods divide the native 128-frame quantum. Phase zero
      // and all parameter/snapshot boundaries stay on the exact sample grid.
      // The discrete sums include folded harmonics, unlike a continuous sinc²
      // approximation: edge samples are 0 for pulse and ±4/(3N) corner corrections.
      const n = 1 / step;
      near(waves[key][2][bin], 4 / n / Math.tan(Math.PI / n), `${key} pulse discrete fundamental`);
      near(waves[key][3][bin], 8 / (n * n * Math.sin(Math.PI / n) ** 2) - 16 / (3 * n * n), `${key} triangle discrete fundamental`);
      for (const ch of [2, 3]) near(waves[key][ch][bin === 'bin4' ? 'bin8' : 'bin4'], 0, `${key} VA excludes wrong frequency`);
      assert(waves[key][4].peak <= 1 && waves[key][4].variance > .05, `${key} bounded changing noise`);
    }
    const firstNoise = Math.fround(2 * Number(19n * 48271n % 2147483647n) / 2147483647 - 1);
    for (const [ch, value] of [[0, .25], [1, 0], [2, 0], [3, -1 + 4 / (3 * 64)], [4, firstNoise]]) near(waves.reset[ch].mean, value, `held reset wave ${ch}`);
    manifest.checks.browserWavetableAndVa = 'PASS';

  } catch (error) { manifest.failure = String(error); throw error; }
  finally { writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify(manifest, null, 2)); await browser?.close(); if (server) await new Promise((yes, no) => server.httpServer.close(error => error ? no(error) : yes())); }
});
