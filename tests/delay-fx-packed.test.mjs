import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '..');
const run = (command, args, cwd) => execFileSync(command, command === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('packed delay FX: isolated low-pass feedback render and 48 kHz browser controls/restore', { timeout: 180000 }, async () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-delay-fx-'));
  cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
  cpSync(join(root, 'tests/delay-fx-consumer'), consumer, { recursive: true });
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts', 'capture.ts'] }));
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  assert(pack.files.some(f => f.path === 'dist/delay-fx.d.ts'));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  run('npm', ['run', 'check'], consumer);
  run('node', ['render.mjs'], consumer);
  run('npm', ['run', 'build'], consumer);
  console.log('Delay FX performance:', run('node', ['performance.mjs'], consumer).trim());
  const { preview } = await import(pathToFileURL(join(consumer, 'node_modules/vite/dist/node/index.js')).href);
  const server = await preview({ root: consumer, configFile: false, preview: { host: '127.0.0.1', port: 0 } });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => typeof window.runFx === 'function');
    const result = await page.evaluate(() => window.runFx());
    assert.equal(result.sampleRate, 48000);
    for (const [name, value] of [['initial', 0.5], ['dry', 0.25], ['bypass', 0.25], ['cleared', 0], ['resumed', 0.5], ['invalid', 0.25], ['after', 0.5]]) {
      assert.equal(result[name].length, 256);
      assert(result[name].every(x => Math.abs(x - value) < 3e-6), name);
    }
    assert.equal(result.timingRejected, true); assert.equal(result.restored.ok, true);
    const artifacts = join(root, 'artifacts/delay-fx'); mkdirSync(artifacts, { recursive: true });
    for (const file of ['native-baseline-input.f32le', 'native-baseline.json']) rmSync(join(artifacts, file), { force: true });
    const files = {};
    for (const file of ['den.tgz', 'package-lock.json', 'performance.json', ...[44100, 48000, 96000].flatMap(rate => [`fx-${rate}.wav`, `fx-${rate}.svg`])]) {
      copyFileSync(join(consumer, file), join(artifacts, file)); files[file] = hash(join(artifacts, file));
    }
    writeFileSync(join(artifacts, 'browser.json'), JSON.stringify(result, null, 2)); files['browser.json'] = hash(join(artifacts, 'browser.json'));
    const sustained = await page.evaluate(() => window.runSustainedFx());
    const channels = sustained.channels.map(values => Float32Array.from(values));
    const rawNames = ['input', 'left', 'right'];
    for (let ch = 0; ch < 3; ch++) {
      const file = `browser-sustained-${rawNames[ch]}.f32le`;
      const bytes = Buffer.alloc(channels[ch].length * 4);
      channels[ch].forEach((value, n) => bytes.writeFloatLE(value, n * 4));
      writeFileSync(join(artifacts, file), bytes); files[file] = hash(join(artifacts, file));
    }
    const { channels: _channels, ...captureInfo } = sustained;
    writeFileSync(join(artifacts, 'browser-sustained.json'), JSON.stringify(captureInfo, null, 2));
    files['browser-sustained.json'] = hash(join(artifacts, 'browser-sustained.json'));
    assert.equal(sustained.sampleRate, 48000); assert.equal(sustained.frames, 2 ** 19);

    const g = Math.tan(Math.PI * 1000 / 48000), norm = 1 / (1 + 2 * g + g * g), b0 = g * g * norm;
    const errors = [];
    for (let ch = 0; ch < 2; ch++) {
      const written = []; let x1 = 0, x2 = 0, y1 = 0, y2 = 0, maximumError = 0, worstFrame = 0;
      const delay = Math.min(0.1 * 48000, (ch ? sustained.settings.timeRight : sustained.settings.timeLeft) * 48000);
      for (let n = 0; n < sustained.frames; n++) {
        const position = n - delay, lo = Math.floor(position), alpha = position - lo;
        const at = index => index >= 0 && index < n ? written[index] : 0;
        const wet = Math.fround(at(lo) * (1 - alpha) + at(lo + 1) * alpha);
        const filtered = b0 * (wet + 2 * x1 + x2) - 2 * (g * g - 1) * norm * y1 - (1 - 2 * g + g * g) * norm * y2;
        x2 = x1; x1 = wet; y2 = y1; y1 = filtered;
        written[n] = Math.fround(channels[0][n] + Math.fround(Math.fround(filtered) * sustained.settings.feedback));
        const error = Math.abs(channels[ch + 1][n] - wet);
        if (error > maximumError) { maximumError = error; worstFrame = n; }
      }
      errors.push({ channel: ch, maximumError, worstFrame });
    }
    assert(sustained.processedFrames >= sustained.frames, 'capture processed every requested frame');
    const firstInput = channels[0].findIndex(x => Math.abs(x) > 1e-5);
    let lastInput = channels[0].length - 1;
    while (lastInput >= 0 && Math.abs(channels[0][lastInput]) <= 1e-5) lastInput--;
    let inputRecurrenceError = 0;
    for (let n = firstInput + 2; n <= lastInput; n++) {
      inputRecurrenceError = Math.max(inputRecurrenceError, Math.abs(channels[0][n] - 2 * Math.cos(2 * Math.PI * 220 / 48000) * channels[0][n - 1] + channels[0][n - 2]));
    }
    const verification = { errors, firstInput, lastInput, inputRecurrenceError, reference: 'actual downstream raw input through independent direct-form feedback reference', threshold: 6e-6, limitation: 'Graph-sample continuity only; no hardware-output or scheduler deadline counter. Deadline traces remain separate.' };
    writeFileSync(join(artifacts, 'browser-sustained-verification.json'), JSON.stringify(verification, null, 2));
    files['browser-sustained-verification.json'] = hash(join(artifacts, 'browser-sustained-verification.json'));
    console.log('Sustained browser verification:', JSON.stringify(verification));
    {
      // Always run the ten-second native control; do not select a passing retry.
      const baseline = await page.evaluate(() => window.runSustainedFx(true));
      const samples = baseline.channels[0];
      const first = samples.findIndex(x => Math.abs(x) > 1e-5);
      let last = samples.length - 1; while (last >= 0 && Math.abs(samples[last]) <= 1e-5) last--;
      let discontinuity = 0;
      for (let n = first + 2; n <= last; n++) discontinuity = Math.max(discontinuity, Math.abs(samples[n] - 2 * Math.cos(2 * Math.PI * 220 / 48000) * samples[n - 1] + samples[n - 2]));
      const bytes = Buffer.alloc(samples.length * 4); samples.forEach((x, n) => bytes.writeFloatLE(x, n * 4));
      writeFileSync(join(artifacts, 'native-baseline-input.f32le'), bytes);
      writeFileSync(join(artifacts, 'native-baseline.json'), JSON.stringify({ ...baseline, channels: undefined, first, last, discontinuity }, null, 2));
      for (const file of ['native-baseline-input.f32le', 'native-baseline.json']) files[file] = hash(join(artifacts, file));
      console.log('Native capture baseline:', JSON.stringify({ first, last, discontinuity }));
      assert(baseline.processedFrames >= baseline.frames);
      assert.equal(last - first, baseline.source.durationSeconds * 48000 - 2);
      assert(discontinuity < 1e-6, 'continuous native baseline');
      assert.deepEqual(baseline.channels[1], baseline.channels[0]);
      assert.deepEqual(baseline.channels[2], baseline.channels[0]);
    }
    writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(['src/delay-fx.ts', 'src/delay-readhead.ts', 'src/filter.ts', 'src/lfo.ts', 'tests/delay-fx.spec.ts', 'tests/delay-fx-packed.test.mjs', 'tests/delay-fx-consumer/processor.ts', 'tests/delay-fx-consumer/capture.ts', 'tests/delay-fx-consumer/main.js', 'tests/delay-fx-consumer/render.mjs', 'tests/delay-fx-consumer/performance.mjs', 'package-lock.json'].map(file => [file, hash(join(root, file))])), den: '0.0.0', unworklet: '0.4.1', node: process.version, engine: 'den.delay.fx.consumer.v1', settings: { maxDelaySeconds: 0.1, tone: 'lowpass', Q: 0.5, stereoPhaseCycles: 0.5, interpolation: 'linear', transition: 'moving head', initialHistory: 'zero' }, parameters: { timeSamples: [8, 12], feedback: 0.5, cutoffHz: 1000, mix: 1, sync: false, bpm: 120, beatsLeft: 1, beatsRight: 1.5, rateHz: 0, depthSeconds: 0, bypass: false, reset: false, browserSequence: ['steady', 'mix=0', 'mix=1,bypass=true', 'bypass=false,reset=true', 'reset=false', 'sync=true (rejected)', 'restore steady snapshot'] }, input: { offline: 'stereo impulses: L[0]=1, R[16]=-0.5, otherwise zero; 2048 frames', browser: 'mono constant 0.25 upmixed by Web Audio to stereo' }, channels: 2, samples: 2048, midi: [], seed: null, preset: null, offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [48000], sustainedBrowser: { frames: sustained.frames, source: sustained.source, settings: sustained.settings, inputAndOutputs: 'three raw f32le files, 48000 Hz', verification }, verification: 'Independent unbounded feedback timeline plus direct-form biquad; strict isolated consumer typecheck; actual browser mix/bypass/reset/capacity rejection and same-schema restoration', limitations: ['Not human approved', 'Public packed subpath import; browser coverage is 48 kHz only', 'This engine fixture is separate from the Chorus/Rhythmic settings fixtures'], files }, null, 2));
    assert.deepEqual(sustained.errors.filter(error => error.code !== 'sab-unavailable'), []);
    assert(firstInput >= 0 && lastInput - firstInput === 4 * 48000 - 2, 'continuous four-second native input');
    assert(inputRecurrenceError < 1e-6, `native input discontinuity ${inputRecurrenceError}`);
    for (const error of errors) assert(error.maximumError < 6e-6, JSON.stringify(error));

  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  }
});
