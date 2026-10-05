import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
test('packed public spectral gate matches DFT/WOLA, restores every quantum phase and builds', { timeout: 180000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-spectral-gate-'));
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', file), join(consumer, file));
  cpSync(join(root, 'tests/spectral-gate-consumer'), consumer, { recursive: true });
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  for (const module of ['spectral-gate', 'spectral-stft', 'spectral-fft']) for (const ext of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/${module}.${ext}`));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  assert.deepEqual(JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'))).exports['./spectral-gate'], { types: './dist/spectral-gate.d.ts', import: './dist/spectral-gate.js' });
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
  run('npm', ['run', 'check'], consumer);
  console.log(run('node', ['render.mjs'], consumer));
  console.log(run('npm', ['run', 'build'], consumer));
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], root).trim();
  const path = join(root, 'artifacts/spectral-gate-public', new Date().toISOString().replaceAll(':', '-') + '-' + sourceCommit.slice(0, 7)); mkdirSync(path, { recursive: true });
  const files = {};
  for (const file of ['den.tgz', 'package-lock.json', 'spectral-gate-results.json', 'candidate-spectral-gate-48000.wav']) { copyFileSync(join(consumer, file), join(path, file)); files[file] = hash(join(path, file)); }
  const sources = ['src/spectral-fft.ts', 'src/spectral-stft.ts', 'src/spectral-gate.ts', 'docs/spectral-gate-entry.md', 'tests/spectral-gate.spec.ts', 'tests/spectral-gate-reset-large.spec.ts', 'tests/spectral-hook-compatibility.spec.ts', 'tests/probes/stft-before-gate-hook.ts', 'tests/spectral-gate-packed.test.mjs', 'tests/spectral-gate-consumer/oracle.mjs', 'tests/spectral-gate-consumer/processor.ts', 'tests/spectral-gate-consumer/render.mjs', 'tests/spectral-gate-consumer/vite.config.mjs', 'tests/spectral-gate-consumer/main.ts', 'tests/spectral-gate-consumer/index.html', 'package.json', 'package-lock.json'];
  writeFileSync(join(path, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit, sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(file => [file, hash(join(root, file))])),
    packageIntegrity: pack.integrity, node: process.version, unworklet: '0.4.1', offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [], files,
    verified: ['Isolated public typecheck', 'N1024 both legal hops at three rates', 'Independent dense DFT/bin gate/inverse DFT/time-indexed WOLA', 'Bit-identical continuation in every quantum phase class', 'Fixed memory and zero scrubs', 'Vite worklet compilation'],
    limitations: ['Not human-approved', 'No browser or realtime acceptance', 'FFT executes every128 samples even at larger hops', 'Cold and observed warm maxima can exceed deadline', 'No pitch/time or convolution expansion', 'Reference alignment N is not universal processed transient onset', 'Normalized input; bin attenuation can raise output peaks; no limiter'] }, null, 2));
  console.log(`Spectral gate public evidence: ${path}`);
});
