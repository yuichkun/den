import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? join(tmpdir(), 'den-npm-cache') } });
test('packed resident WSOLA declarations, native duration/pitch, independent signals and fixed-memory proof', { timeout: 180000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-resident-time-stretch-'));
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', file), join(consumer, file));
  cpSync(join(root, 'tests/resident-time-stretch-consumer'), consumer, { recursive: true });
  copyFileSync(join(root, 'tests/fixtures/resident-time-stretch-reference.ts'), join(consumer, 'reference.ts'));
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  for (const extension of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/resident-time-stretch.${extension}`));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'), 'utf8'));
  assert.deepEqual(installed.exports['./resident-time-stretch'], { types: './dist/resident-time-stretch.d.ts', import: './dist/resident-time-stretch.js' });
  run('node', ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'processor.ts'], consumer);
  console.log(run('node', ['render.ts'], consumer));
  const trial = `${new Date().toISOString().replaceAll(':', '-')}-${run('git', ['rev-parse', '--short', 'HEAD'], root).trim()}`;
  const output = join(root, 'artifacts/resident-time-stretch', trial); mkdirSync(output, { recursive: true });
  const files = {};
  for (const file of readdirSync(consumer).filter(file => file.startsWith('candidate-') || ['resident-time-stretch-results.json', 'package-lock.json', 'den.tgz'].includes(file))) {
    copyFileSync(join(consumer, file), join(output, file)); files[file] = hash(join(output, file));
  }
  const sources = ['src/resident-time-stretch.ts', 'docs/resident-time-stretch.md', 'tests/resident-time-stretch.spec.ts', 'tests/fixtures/resident-time-stretch-reference.ts', 'tests/resident-time-stretch-packed.test.mjs', 'tests/resident-time-stretch-consumer/processor.ts', 'tests/resident-time-stretch-consumer/render.ts', 'package.json', 'package-lock.json'];
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(file => [file, hash(join(root, file))])), packageIntegrity: pack.integrity, consumerLockSha256: hash(join(consumer, 'package-lock.json')), unworklet: '0.4.1', node: process.version, publicSubpaths: ['/resident-time-stretch'], offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [], frames: 8192, files,
    verification: 'Strict isolated public types, actual native resident ingress and launch-latched duration/pitch, independent source-time and analytic frequency/duration proofs, same-schema mid-hop snapshots, reset/reload, zero scrubbing and maximum fixed memory',
    limitations: ['Not human approved', 'Fixed sparse WSOLA alignment can color/cancel/repeat/skip/smear', 'Linear interpolation aliases and finite edges pad/truncate', 'Mono resident one-shot only; no streaming, formants or stereo coherence', 'No browser or realtime deadline evidence; eager search runs while stopped'] }, null, 2));
  console.log(`Resident WSOLA evidence: ${output}`);
});
