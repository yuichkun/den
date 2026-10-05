import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (cmd, args, cwd) => execFileSync(cmd, cmd === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args,
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('packed dynamics: isolated strict TypeScript, actual DSP, snapshots and bounded-cost evidence', { timeout: 180000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-dynamics-'));
  cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
  cpSync(join(root, 'tests/dynamics-consumer'), consumer, { recursive: true });
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  for (const extension of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/dynamics.${extension}`));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  const installedPackage = JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'), 'utf8'));
  assert.deepEqual(installedPackage.exports['./dynamics'], { types: './dist/dynamics.d.ts', import: './dist/dynamics.js' });
  const publicSubpath = true, importPath = '@denaudio/den/dynamics';
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
  run('npm', ['run', 'check'], consumer);
  console.log(run('node', ['render.mjs'], consumer));
  const trial = `${new Date().toISOString().replaceAll(':', '-')}-${run('git', ['rev-parse', '--short', 'HEAD'], root).trim()}`;
  const dir = join(root, 'artifacts/dynamics', trial); mkdirSync(dir, { recursive: true });
  console.log(`Dynamics evidence: ${dir}`);
  const files = {};
  for (const file of readdirSync(consumer).filter(file => /^candidate-.*\.wav$/.test(file) || ['dynamics-results.json', 'package-lock.json', 'den.tgz'].includes(file))) {
    copyFileSync(join(consumer, file), join(dir, file)); files[file] = hash(join(dir, file));
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(),
    sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(['src/dynamics.ts', 'docs/dynamics.md', 'tests/dynamics.spec.ts', 'tests/dynamics-packed.test.mjs', 'tests/dynamics-consumer/processor.ts', 'tests/dynamics-consumer/render.mjs', 'package.json', 'package-lock.json'].map(file => [file, hash(join(root, file))])),
    packageIntegrity: pack.integrity, publicSubpath, testedImport: importPath, unworklet: '0.4.1', node: process.version,
    offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [], frames: 32768, channels: 2,
    input: 'L=0.5*sin(2*pi*110*n/rate), R=-L/2; sidechain L=0.8 on frames2048..16383, zero elsewhere; sidechain R=0',
    settings: { detector: 'rms', thresholdDb: -12, ratio: 4, kneeDb: 6, rangeDb: 36, attack: 0.003, release: 0.07, detectorAttack: 0.001, detectorRelease: 0.01, hysteresisDb: 3 },
    seed: null, midi: [], preset: null, files,
    verification: 'Independent power one-pole and input/output dB curve; stereo tracking, scrub diagnostics, identical-schema restoration; immutable memory allocation and local driver timings',
    limitations: ['Not human approved', 'No browser or hardware real-time evidence in this lane', ...(publicSubpath ? [] : ['Public subpath export pending integration; packed-file import verified']), 'No lookahead, true-peak limiter, multiband or sidechain filter'],
  }, null, 2));
});
