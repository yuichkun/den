import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..'), hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (cmd, args, cwd) => execFileSync(cmd, cmd === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
test('packed pitch-band wavetable: full resident, strict public types, spectral content, replacement and native snapshots', { timeout: 180000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-wavetable-bands-'));
  cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
  cpSync(join(root, 'tests/wavetable-bands-consumer'), consumer, { recursive: true });
  copyFileSync(join(root, 'tests/fixtures/wavetable-bands-reference.ts'), join(consumer, 'wavetable-bands-reference.ts'));
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  for (const name of ['wavetable']) for (const extension of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/${name}.${extension}`));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8')); lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2)); run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'), 'utf8'));
  for (const name of ['wavetable']) assert.deepEqual(installed.exports[`./${name}`], { types: `./dist/${name}.d.ts`, import: `./dist/${name}.js` });
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
  run('npm', ['run', 'check'], consumer); console.log(run('node', ['render.mjs'], consumer));
  const dir = join(root, 'artifacts/wavetable-bands', `${new Date().toISOString().replaceAll(':', '-')}-${run('git', ['rev-parse', '--short', 'HEAD'], root).trim()}`); mkdirSync(dir, { recursive: true });
  const files = {};
  for (const file of readdirSync(consumer).filter(file => /^candidate-.*\.wav$/.test(file) || ['wavetable-bands-results.json', 'package-lock.json', 'den.tgz'].includes(file))) { copyFileSync(join(consumer, file), join(dir, file)); files[file] = hash(join(dir, file)); }
  const sources = ['src/wavetable.ts', 'src/wavetable-bands.ts', 'src/wavetable-read.ts', 'tests/wavetable-precision.spec.ts', 'tests/fixtures/wavetable-before-local-fraction.ts', 'tests/fixtures/wavetable-bands-before-local-fraction.ts', 'src/sample.ts', 'docs/wavetable-bands.md', 'tests/wavetable-bands.spec.ts', 'tests/fixtures/wavetable-bands-reference.ts', 'tests/wavetable-bands-packed.test.mjs', 'tests/wavetable-bands-consumer/processor.ts', 'tests/wavetable-bands-consumer/render.mjs', 'package.json', 'package-lock.json'];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain', '--untracked-files=no'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(file => [file, hash(join(root, file))])), packageIntegrity: pack.integrity, consumerLockHash: hash(join(consumer, 'package-lock.json')), unworklet: '0.4.1', node: process.version,
    publicSubpaths: ['/wavetable'], prerequisiteSubpath: '/sample', sampleRates: [44100, 48000, 96000], frames: 4096, settings: { frameLength: 512, frameCount: 16, bands: 8, totalPcmSamples: 65536, tablePhase: .975, controls: 'See processor/render source hashes: every pitch boundary, upward sweep, continuous frame scan, held reset, native full/short/edited asset replacement' }, files,
    verification: 'Independent Fourier coefficients and piecewise pitch-band/frame/periodic interpolation, full resident, strict packed public types, native replacement and exact same-schema snapshots',
    limitations: ['Not human approved', 'Harmonic-truncated assets retain linear interpolation images; arbitrary FM/PM/scan/reset/replacement can add bandwidth', 'No browser or hardware realtime evidence', 'Timing uses unloaded compile driver; PCM copy belongs to native resident ingress', 'No cross-schema migration guarantee'],
  }, null, 2)); console.log(`Pitch-band wavetable evidence: ${dir}`);
});
