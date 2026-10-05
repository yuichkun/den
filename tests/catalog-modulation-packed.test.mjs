import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const run = (cmd, args, cwd) => execFileSync(cmd, cmd === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
test('catalog FX public packed entries typecheck, render and bundle in an isolated consumer', { timeout: 180000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-catalog-modulation-'));
  try {
    for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', file), join(consumer, file));
    cpSync(join(root, 'tests/catalog-modulation-consumer'), consumer, { recursive: true });
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
    const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
    for (const name of ['modulation-fx', 'stereo-delay', 'reverb']) for (const ext of ['js', 'd.ts']) assert(pack.files.some(f => f.path === `dist/${name}.${ext}`));
    copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
    writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock));
    run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
    run('npm', ['run', 'check'], consumer);
    run('node', ['render.mjs'], consumer);
    run('npm', ['run', 'build'], consumer);
    const artifacts = join(root, 'artifacts/catalog-modulation'); mkdirSync(artifacts, { recursive: true });
    const files = ['den.tgz', 'package-lock.json', 'verification.json', ...[44100, 48000, 96000].flatMap(rate => ['flanger', 'phaser', 'pingpong', 'multitap', 'reverb'].map(name => `${name}-${rate}.wav`))];
    for (const file of files) copyFileSync(join(consumer, file), join(artifacts, file));
    const sources = ['src/modulation-fx.ts', 'src/stereo-delay.ts', 'src/reverb.ts', 'tests/catalog-modulation-fx.spec.ts', 'tests/catalog-reverb.spec.ts', 'tests/catalog-modulation-packed.test.mjs', 'tests/catalog-modulation-consumer/processor.ts', 'tests/catalog-modulation-consumer/render.mjs', 'package.json', 'package-lock.json'];
    writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', node: process.version, unworklet: '0.4.1', sampleRates: [44100, 48000, 96000], sourceHashes: Object.fromEntries(sources.map(f => [f, hash(join(root, f))])), files: Object.fromEntries(files.map(f => [f, hash(join(artifacts, f))])), limitations: ['Not human-approved', 'Offline render and Vite bundle, no browser-runtime or real-time-deadline verification', 'Construction-fixed reverb RT60, room scale and damping; no convolution or special tails'] }, null, 2));
  } finally { rmSync(consumer, { recursive: true, force: true }); }
});
