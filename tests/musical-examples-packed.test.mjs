import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (cmd, args, cwd) => execFileSync(cmd, cmd === 'npm' ? ['--cache', process.env.npm_config_cache || join(tmpdir(), 'den-npm-cache'), ...args] : args,
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024 });
test('packed musical examples: four bounded CANDIDATE A/B pairs with independent three-rate audio and exact continuation', { timeout: 240000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-musical-examples-'));
  cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
  cpSync(join(root, 'tests/musical-examples-consumer'), consumer, { recursive: true });
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  for (const name of ['musical-examples', 'musical-materials']) for (const ext of ['js', 'd.ts']) assert(pack.files.some(f => f.path === `dist/${name}.${ext}`));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'), 'utf8'));
  assert.deepEqual(installed.exports['./musical-examples'], { types: './dist/musical-examples.d.ts', import: './dist/musical-examples.js' });
  run('npm', ['run', 'check'], consumer); console.log(run('node', ['render.mjs'], consumer));
  const dir = join(root, 'artifacts/musical-examples', `${new Date().toISOString().replaceAll(':', '-')}-${run('git', ['rev-parse', '--short', 'HEAD'], root).trim()}`);
  mkdirSync(dir, { recursive: true });
  const files = {};
  for (const file of readdirSync(consumer).filter(f => f.startsWith('candidate-') || ['musical-examples-results.json', 'den.tgz', 'package-lock.json'].includes(f))) {
    copyFileSync(join(consumer, file), join(dir, file)); files[file] = hash(join(dir, file));
  }
  const sources = ['src/musical-examples.ts', 'src/musical-materials.ts', 'tests/musical-examples.spec.ts', 'tests/musical-examples-packed.test.mjs',
    'tests/musical-examples-consumer/reference.mjs', 'tests/musical-examples-consumer/checks.mjs', 'tests/musical-examples-consumer/contract.ts',
    'tests/musical-examples-consumer/render.mjs', 'docs/musical-examples.md', 'package.json', 'package-lock.json'];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(),
    sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(f => [f, hash(join(root, f))])),
    packageSHA256: hash(join(consumer, 'den.tgz')), packageIntegrity: pack.integrity, consumerLockSHA256: hash(join(consumer, 'package-lock.json')),
    node: process.version, unworklet: '0.4.1', publicEntry: '@denaudio/den/musical-examples', files,
    assetProvenance: 'Original host-side analytic sums of sines. No external recording or downloaded sample. Fixed weights, no peak/RMS normalization.',
    fixtureContract: 'Each JSON records every expanded native parameter, message timing/asset hash, input hash, exact frame count, and same-schema split. WAV is unnormalized 32-bit float stereo with the explicit patch gain applied.',
    evidence: 'See musical-examples-results.json for all 24 three-rate A/B rows, independent errors, gain/headroom/tails, repeated PCM hashes, same-schema continuations and allocation observations.',
    approval: { humanListening: false, approvedGolden: false, hardwareRealtime: false, browser: false },
  }, null, 2));
  console.log(`Musical CANDIDATE evidence: ${dir}`);
});
