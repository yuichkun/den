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
test('packed live buffer public types, exact native chronological age reference, snapshots and worklet build', { timeout: 180000 }, () => {
  const trial = `${new Date().toISOString().replaceAll(':', '-')}-${run('git', ['rev-parse', '--short', 'HEAD'], root).trim()}`;
  const output = join(root, 'artifacts/live-buffer', trial); mkdirSync(output, { recursive: true });
  const consumer = mkdtempSync(join(tmpdir(), 'den-live-buffer-'));
  const sources = ['src/live-buffer.ts', 'docs/live-buffer.md', 'tests/live-buffer.spec.ts', 'tests/fixtures/live-buffer-reference.ts', 'tests/live-buffer-packed.test.mjs', ...readdirSync(join(root, 'tests/live-buffer-consumer')).map(file => `tests/live-buffer-consumer/${file}`), 'package.json', 'package-lock.json'];
  const provenance = { status: 'CANDIDATE', runtime: 'NOT_CLEARED', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(file => [file, hash(join(root, file))])), consumer, unworklet: '0.4.1', node: process.version };
  writeFileSync(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2));
  let phase = 'prepare';
  try {
    for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', file), join(consumer, file));
    cpSync(join(root, 'tests/live-buffer-consumer'), consumer, { recursive: true });
    copyFileSync(join(root, 'tests/fixtures/live-buffer-reference.ts'), join(consumer, 'reference.ts'));
    phase = 'pack'; const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
    for (const extension of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/live-buffer.${extension}`));
    copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8')); lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity; writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
    phase = 'install'; writeFileSync(join(output, 'install.log'), run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer));
    const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'), 'utf8'));
    assert.deepEqual(installed.exports['./live-buffer'], { types: './dist/live-buffer.d.ts', import: './dist/live-buffer.js' });
    phase = 'types'; writeFileSync(join(output, 'types.log'), run('node', ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'processor.ts'], consumer));
    phase = 'render'; const rendered = run('node', ['render.ts'], consumer); writeFileSync(join(output, 'render.log'), rendered); console.log(rendered);
    phase = 'build'; writeFileSync(join(output, 'build.log'), run('npm', ['run', 'build'], consumer));
    const assets = readdirSync(join(consumer, 'dist/assets')); assert(assets.some(file => file.endsWith('.wasm'))); assert(assets.some(file => /worklet.*\.js$/.test(file)));
    cpSync(join(consumer, 'dist'), join(output, 'build'), { recursive: true });
    const files = {};
    for (const file of readdirSync(consumer).filter(file => file.startsWith('candidate-') || ['live-buffer-results.json', 'package-lock.json', 'den.tgz'].includes(file))) { copyFileSync(join(consumer, file), join(output, file)); files[file] = hash(join(output, file)); }
    writeFileSync(join(output, 'manifest.json'), JSON.stringify({ ...provenance, packageIntegrity: pack.integrity, consumerLockSha256: hash(join(consumer, 'package-lock.json')), publicSubpaths: ['/live-buffer'], offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [], buildSampleRates: [48000], frames: 4096, files, buildAssets: Object.fromEntries(assets.map(file => [file, hash(join(consumer, 'dist/assets', file))])), verification: 'Strict isolated public types, all-sample exact independent chronological references, wrap, age validity and pause/reset, same-schema snapshots, fixed memory, zero scrubbing and actual Vite worklet/WASM build', limitations: ['Not human approved', 'No browser/device/realtime execution evidence', 'Accepted-write age reader, not ResidentSample or a granular scheduler', 'Reset leaves unreachable stale PCM in snapshots', 'Signed zero records as positive zero', 'No asset loading, device input, overdub, normalization or limiter'] }, null, 2));
    console.log(`Live buffer evidence: ${output}`);
  } catch (error) {
    writeFileSync(join(output, 'failure.json'), JSON.stringify({ ...provenance, phase, error: String(error), stdout: error.stdout?.toString(), stderr: error.stderr?.toString() }, null, 2));
    throw error;
  }
});
