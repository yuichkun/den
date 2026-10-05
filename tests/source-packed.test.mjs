import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (cmd, args, cwd) => execFileSync(cmd, cmd === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('packed sources/resonators: isolated strict types, actual renders, snapshots and fixed-cost diagnostics', { timeout: 180000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-sources-'));
  cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
  cpSync(join(root, 'tests/source-consumer'), consumer, { recursive: true });
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  for (const name of ['source', 'resonator']) for (const extension of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/${name}.${extension}`));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'), 'utf8'));
  for (const name of ['source', 'resonator']) assert.deepEqual(installed.exports[`./${name}`], { types: `./dist/${name}.d.ts`, import: `./dist/${name}.js` });
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
  run('npm', ['run', 'check'], consumer);
  console.log(run('node', ['render.mjs'], consumer));
  const trial = `${new Date().toISOString().replaceAll(':', '-')}-${run('git', ['rev-parse', '--short', 'HEAD'], root).trim()}`;
  const dir = join(root, 'artifacts/sources', trial); mkdirSync(dir, { recursive: true });
  const files = {};
  for (const file of readdirSync(consumer).filter(file => /^candidate-.*\.wav$/.test(file) || ['source-results.json', 'package-lock.json', 'den.tgz'].includes(file))) {
    copyFileSync(join(consumer, file), join(dir, file)); files[file] = hash(join(dir, file));
  }
  const sources = ['src/source.ts', 'src/resonator.ts', 'docs/sources.md', 'tests/source.spec.ts', 'tests/resonator.spec.ts', 'tests/fixtures/source-reference.ts',
    'tests/fixtures/comb-output-normalization-before.ts', 'tests/source-packed.test.mjs', 'tests/source-consumer/processor.ts', 'tests/source-consumer/render.mjs', 'package.json', 'package-lock.json'];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(),
    sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(file => [file, hash(join(root, file))])),
    packageIntegrity: pack.integrity, consumerLockHash: hash(join(consumer, 'package-lock.json')), unworklet: '0.4.1', node: process.version,
    publicSubpaths: ['/source', '/resonator'], offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [], frames: 8192,
    settings: { pm: { carrierHz: 440, modulatorHz: 110, depthRadians: 2, feedbackRadians: 0 }, fm: { carrierHz: 440, modulatorHz: 110, deviationHz: 220, feedbackHz: 0 },
      additive: '32 partials ratio i+1 gain 1/(i+1), base110Hz', unison: '8 sine voices centered linear pan, ±28cent detune, base220Hz',
      modal: '16 modes 300+111*i Hz, T60 .2+.01*i, gain1/(i+1)', comb: 'min20Hz, frequency sampleRate/64, feedback.5, damping0' },
    excitation: 'unit impulse at frame0 to resonators; no external audio', reset: false, seed: null, midi: [], preset: null, files,
    verification: 'Independent Math.sin, FM phase integral, weighted sine banks, damped sinusoidal impulse and comb repeat series; exact same-schema continuation; public strict TypeScript; fixed memory and bounded local driver diagnostic',
    limitations: ['Not human approved', 'No browser or hardware real-time evidence', 'PM/FM and dynamic sources can alias', 'Sustained modal output can exceed unity; normalized comb has documented finite-precision allowance', 'No sample, granular, FFT or cross-schema migration guarantee'],
  }, null, 2));
  console.log(`Source evidence: ${dir}`);
});
