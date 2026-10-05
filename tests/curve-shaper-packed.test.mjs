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
test('packed editable curve-shaper public declarations, native parameter edits, quadrature and state/cost proof', { timeout: 180000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-curve-shaper-'));
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', file), join(consumer, file));
  cpSync(join(root, 'tests/curve-shaper-consumer'), consumer, { recursive: true });
  copyFileSync(join(root, 'tests/fixtures/curve-shaper-reference.ts'), join(consumer, 'reference.ts'));
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  for (const extension of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/curve-shaper.${extension}`));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'), 'utf8'));
  assert.deepEqual(installed.exports['./curve-shaper'], { types: './dist/curve-shaper.d.ts', import: './dist/curve-shaper.js' });
  run('node', ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'processor.ts'], consumer);
  console.log(run('node', ['render.ts'], consumer));
  const trial = `${new Date().toISOString().replaceAll(':', '-')}-${run('git', ['rev-parse', '--short', 'HEAD'], root).trim()}`;
  const output = join(root, 'artifacts/curve-shaper', trial); mkdirSync(output, { recursive: true });
  const files = {};
  for (const file of readdirSync(consumer).filter(file => file.startsWith('candidate-') || ['curve-shaper-results.json', 'package-lock.json', 'den.tgz'].includes(file))) {
    copyFileSync(join(consumer, file), join(output, file)); files[file] = hash(join(output, file));
  }
  const sources = ['src/curve-shaper.ts', 'docs/curve-shaper.md', 'tests/curve-shaper.spec.ts', 'tests/fixtures/curve-shaper-reference.ts', 'tests/fixtures/rejected-fractional-curve-shaper.ts', 'tests/curve-shaper-packed.test.mjs', 'tests/curve-shaper-consumer/processor.ts', 'tests/curve-shaper-consumer/render.ts', 'package.json', 'package-lock.json'];
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(file => [file, hash(join(root, file))])), packageIntegrity: pack.integrity, consumerLockSha256: hash(join(consumer, 'package-lock.json')), unworklet: '0.4.1', node: process.version, publicSubpaths: ['/curve-shaper'], offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [], frames: 8192, files,
    verification: 'Strict isolated public types, actual native WASM a-rate ordinate/gain/mix edits, independent scalar interpolation/segmented Simpson quadrature, exact same-schema snapshots, reset, zero scrubbing and fixed memory',
    limitations: ['Not human approved', 'No oversampling or higher-order AA', 'Fixed-curve first-order antialiasing does not antialias ordinate edits', 'ADAA dry is a two-sample mean', 'No browser or realtime deadline evidence'] }, null, 2));
  console.log(`Curve-shaper evidence: ${output}`);
});
