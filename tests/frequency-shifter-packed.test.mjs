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
test('packed frequency-shifter entry renders independently at three rates and compiles a Vite worklet', { timeout: 180000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-frequency-shifter-'));
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', file), join(consumer, file));
  cpSync(join(root, 'tests/frequency-shifter-consumer'), consumer, { recursive: true });
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  for (const ext of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/frequency-shifter.${ext}`));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json')));
  assert.deepEqual(installed.exports['./frequency-shifter'], { types: './dist/frequency-shifter.d.ts', import: './dist/frequency-shifter.js' });
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
  run('npm', ['run', 'check'], consumer);
  console.log(run('node', ['render.mjs'], consumer));
  console.log(run('npm', ['run', 'build'], consumer));
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], root).trim();
  const path = join(root, 'artifacts/frequency-shifter', new Date().toISOString().replaceAll(':', '-') + '-' + sourceCommit.slice(0, 7));
  mkdirSync(path, { recursive: true });
  const files = {};
  for (const file of ['den.tgz', 'package-lock.json', 'frequency-shifter-results.json']) { copyFileSync(join(consumer, file), join(path, file)); files[file] = hash(join(path, file)); }
  const sources = ['src/frequency-shifter.ts', 'docs/frequency-shifter.md', 'tests/frequency-shifter.spec.ts', 'tests/frequency-shifter-packed.test.mjs',
    'tests/frequency-shifter-consumer/processor.ts', 'tests/frequency-shifter-consumer/reference.mjs', 'tests/frequency-shifter-consumer/render.mjs', 'package.json', 'package-lock.json'];
  writeFileSync(join(path, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit,
    sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(file => [file, hash(join(root, file))])),
    packageIntegrity: pack.integrity, node: process.version, unworklet: '0.4.1', offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [], files,
    verified: ['Isolated public typecheck', 'Three-rate independent direct convolution and complex sideband DFT', 'Bit-identical native snapshot continuation', 'Fixed memory and zero scrubs', 'Vite worklet compilation'],
    limitations: ['Not human-approved', 'No browser or realtime acceptance', 'Finite Hilbert band; no input bandpass or anti-alias filter', '31-sample group delay, including dry/bypass; FIR pre/post ringing', 'Additive Hz shift, not pitch-ratio shift or time stretch'] }, null, 2));
  console.log(`Frequency-shifter evidence: ${path}`);
});
