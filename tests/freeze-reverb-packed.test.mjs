import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? join(tmpdir(), 'den-npm-cache') } });
test('freeze-tail public packed declarations, native DSP, scalar oracle and persistent histories', { timeout: 180000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-freeze-reverb-'));
  console.log(`Retained freeze-reverb consumer: ${consumer}`);
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', file), join(consumer, file));
  cpSync(join(root, 'tests/freeze-reverb-consumer'), consumer, { recursive: true });
  copyFileSync(join(root, 'tests/fixtures/freeze-reverb-reference.ts'), join(consumer, 'reference.ts'));
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  for (const extension of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/freeze-reverb.${extension}`));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'), 'utf8'));
  assert.deepEqual(installed.exports['./freeze-reverb'], { types: './dist/freeze-reverb.d.ts', import: './dist/freeze-reverb.js' });
  run('node', ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'processor.ts'], consumer);
  try { console.log(run('node', ['render.ts'], consumer)); }
  catch (error) { writeFileSync(join(consumer, 'failure.log'), String(error.stdout ?? '') + '\n' + String(error.stderr ?? '') + '\n' + String(error)); throw error; }
  const trial = `${new Date().toISOString().replaceAll(':', '-')}-${run('git', ['rev-parse', '--short', 'HEAD'], root).trim()}`;
  const output = join(root, 'artifacts/freeze-reverb', trial); mkdirSync(output, { recursive: true });
  const files = {};
  for (const file of readdirSync(consumer).filter(file => file.startsWith('candidate-') || ['freeze-reverb-results.json', 'package-lock.json', 'den.tgz'].includes(file))) {
    copyFileSync(join(consumer, file), join(output, file)); files[file] = hash(join(output, file));
  }
  const sources = ['src/freeze-reverb.ts', 'docs/freeze-reverb.md', 'tests/freeze-reverb.spec.ts', 'tests/fixtures/freeze-reverb-reference.ts', 'tests/freeze-reverb-packed.test.mjs', 'tests/freeze-reverb-consumer/processor.ts', 'tests/freeze-reverb-consumer/render.ts', 'package.json', 'package-lock.json'];
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', musicalVerdict: 'NOT_CLEARED', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '',
    sourceHashes: Object.fromEntries(sources.map(file => [file, hash(join(root, file))])), packageIntegrity: pack.integrity, consumerLockSha256: hash(join(consumer, 'package-lock.json')), unworklet: '0.4.1', node: process.version,
    publicSubpaths: ['/freeze-reverb'], offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [], files,
    verification: 'Strict isolated public types, native WASM a-rate freeze transitions, independent absolute-time recurrence, exact same-schema frozen snapshots, zero scrubbing, fixed maximum memory allocation',
    limitations: ['Not human approved', 'No browser or realtime deadline evidence', 'Frozen energy is approximate in floating point', 'No damping filter, shimmer, IR processing or room-quality promise', 'Reset logically invalidates history rather than physically erasing all buffer bytes'] }, null, 2));
  console.log(`Freeze-reverb evidence: ${output}`);
});
