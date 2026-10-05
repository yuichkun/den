import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(tmpdir(), 'den-npm-cache') } });

test('packed /drive public declarations, real renders, independent oracles and candidate hashes', { timeout: 120000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-drive-'));
  for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', name), join(consumer, name));
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  for (const extension of ['js', 'd.ts']) assert(pack.files.some(f => f.path === `dist/drive.${extension}`));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  for (const name of ['contract.ts', 'render.ts']) copyFileSync(join(root, 'tests/drive-consumer', name), join(consumer, name));
  const reference = readFileSync(join(root, 'tests/fixtures/drive-reference.ts'), 'utf8').replace('../../src/drive.js', '@denaudio/den/drive');
  writeFileSync(join(consumer, 'reference.ts'), reference);
  run('node', ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'contract.ts'], consumer);
  run('node', ['render.ts'], consumer);
  const artifacts = join(root, 'artifacts'); mkdirSync(artifacts, { recursive: true });
  const files = {};
  for (const name of readdirSync(consumer).filter(x => x.startsWith('candidate-') || x === 'drive-consumer-measurements.json')) {
    copyFileSync(join(consumer, name), join(artifacts, name));
    files[name] = hash(readFileSync(join(consumer, name)));
  }
  const sourceFiles = ['src/drive.ts', 'docs/drive.md', 'tests/drive.spec.ts', 'tests/fixtures/drive-reference.ts', 'tests/drive-consumer/render.ts', 'tests/drive-consumer/contract.ts', 'tests/drive-packed.test.mjs', 'package.json', 'package-lock.json'];
  writeFileSync(join(artifacts, 'drive-candidate-manifest.json'), JSON.stringify({
    status: 'CANDIDATE', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '',
    sourceHashes: Object.fromEntries(sourceFiles.map(f => [f, hash(readFileSync(join(root, f)))])),
    packageIntegrity: pack.integrity, consumerLockSha256: hash(readFileSync(join(consumer, 'package-lock.json'))), unworklet: '0.4.1', sampleRates: [44100, 48000, 96000], frames: 8192,
    input: '0.35 * (sin(2*pi*173*n/sampleRate) + 0.3*sin(2*pi*997*n/sampleRate)), f32',
    settings: { drive: 6, mix: 1, dcBlockHz: 0, reductionBits: 6, reductionHoldSamples: 5 },
    format: 'mono IEEE754 f32 native little-endian', files,
    checks: 'isolated public declarations, transfer/segmented Simpson reference error <5e-6, signed quantizer/hold exact samples, exact same-schema snapshots, finite output and zero scrubbing',
    limitations: ['not human approved', 'no realtime/browser performance claim', 'ADAA is not oversampling and does not eliminate all aliasing', 'heavy folding can substantially attenuate high-frequency fundamentals', 'bit/sample reduction intentionally aliases'],
  }, null, 2));
});
