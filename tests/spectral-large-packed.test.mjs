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
test('packed public N1024 STFT renders both hops, restores every quantum phase and builds', { timeout: 180000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-spectral-large-'));
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', file), join(consumer, file));
  cpSync(join(root, 'tests/spectral-large-consumer'), consumer, { recursive: true });
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  for (const module of ['spectral', 'spectral-stft', 'spectral-fft']) for (const ext of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/${module}.${ext}`));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  assert.deepEqual(JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'))).exports['./spectral'], { types: './dist/spectral.d.ts', import: './dist/spectral.js' });
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
  run('npm', ['run', 'check'], consumer);
  console.log(run('node', ['render.mjs'], consumer));
  console.log(run('npm', ['run', 'build'], consumer));
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], root).trim();
  const path = join(root, 'artifacts/spectral-large-public', new Date().toISOString().replaceAll(':', '-') + '-' + sourceCommit.slice(0, 7)); mkdirSync(path, { recursive: true });
  const files = {};
  for (const file of ['den.tgz', 'package-lock.json', 'spectral-large-results.json']) { copyFileSync(join(consumer, file), join(path, file)); files[file] = hash(join(path, file)); }
  const sources = ['src/spectral-fft.ts', 'src/spectral-stft.ts', 'src/spectral.ts', 'docs/spectral.md', 'docs/spectral-large-candidate.md', 'tests/spectral.spec.ts', 'tests/spectral-large.spec.ts', 'tests/spectral-framing-large.spec.ts', 'tests/spectral-large-packed.test.mjs', 'tests/spectral-large-consumer/processor.ts', 'tests/spectral-large-consumer/render.mjs', 'tests/spectral-large-consumer/vite.config.mjs', 'tests/spectral-large-consumer/main.ts', 'tests/spectral-large-consumer/index.html', 'package.json', 'package-lock.json'];
  writeFileSync(join(path, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit, sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(file => [file, hash(join(root, file))])),
    packageIntegrity: pack.integrity, node: process.version, unworklet: '0.4.1', offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [], files,
    verified: ['Isolated public typecheck', 'N1024 both legal hops at three rates', 'Analytical identity latency/reset oracle', 'Bit-identical continuation in every quantum phase class', 'Fixed memory and zero scrubs', 'Vite worklet compilation'],
    limitations: ['Not human-approved', 'No browser or realtime acceptance', 'FFT executes every128 samples even at larger hops', 'Cold and observed warm maxima can exceed deadline', 'No pitch/time or convolution expansion'] }, null, 2));
  console.log(`Large STFT public evidence: ${path}`);
});
