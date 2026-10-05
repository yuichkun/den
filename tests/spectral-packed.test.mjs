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
test('packed spectral and convolution public entries render and build in an isolated consumer', { timeout: 180000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-spectral-'));
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', file), join(consumer, file));
  cpSync(join(root, 'tests/spectral-consumer'), consumer, { recursive: true });
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  for (const module of ['spectral', 'spectral-fft', 'convolution']) for (const ext of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/${module}.${ext}`));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  for (const module of ['spectral', 'convolution']) assert.deepEqual(JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'))).exports[`./${module}`], { types: `./dist/${module}.d.ts`, import: `./dist/${module}.js` });
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
  run('npm', ['run', 'check'], consumer);
  console.log(run('node', ['render.mjs'], consumer));
  console.log(run('npm', ['run', 'build'], consumer));
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], root).trim();
  const path = join(root, 'artifacts/spectral', new Date().toISOString().replaceAll(':', '-') + '-' + sourceCommit.slice(0, 7)); mkdirSync(path, { recursive: true });
  const files = {};
  for (const file of ['den.tgz', 'package-lock.json', 'spectral-results.json']) { copyFileSync(join(consumer, file), join(path, file)); files[file] = hash(join(path, file)); }
  const sources = ['src/spectral-fft.ts', 'src/spectral.ts', 'src/convolution.ts', 'docs/spectral.md', 'docs/convolution.md', 'tests/spectral.spec.ts', 'tests/convolution.spec.ts', 'tests/spectral-packed.test.mjs', 'tests/spectral-consumer/processor.ts', 'tests/spectral-consumer/render.mjs', 'package.json', 'package-lock.json'];
  writeFileSync(join(path, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit, sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(file => [file, hash(join(root, file))])),
    packageIntegrity: pack.integrity, node: process.version, unworklet: '0.4.1', offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [], files,
    verified: ['Isolated public typecheck', 'Three-rate analytical latency/direct FIR', 'Bit-identical native snapshot continuation', 'Fixed memory and zero scrubs', 'Vite worklet compilation'],
    limitations: ['Not human-approved', 'No browser or real-time acceptance', 'Cold first quantum can greatly exceed deadline', 'Small bounded STFT identity/IR only; no pitch/time, long-room convolution or IR swap'] }, null, 2));
  console.log(`Spectral evidence: ${path}`);
});
