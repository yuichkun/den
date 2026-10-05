import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..'), hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (cmd, args, cwd) => execFileSync(cmd, cmd === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
test('packed wavetable/VA: maximum resident, isolated strict types, independent renders and exact snapshots', { timeout: 180000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-wavetable-'));
  cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
  cpSync(join(root, 'tests/wavetable-consumer'), consumer, { recursive: true });
  copyFileSync(join(root, 'tests/fixtures/wavetable-reference.ts'), join(consumer, 'wavetable-reference.ts'));
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  for (const name of ['wavetable', 'virtual-analog']) for (const extension of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/${name}.${extension}`));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8')); lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2)); run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'), 'utf8'));
  for (const name of ['wavetable', 'virtual-analog']) assert.deepEqual(installed.exports[`./${name}`], { types: `./dist/${name}.d.ts`, import: `./dist/${name}.js` });
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
  run('npm', ['run', 'check'], consumer); console.log(run('node', ['render.mjs'], consumer));
  const dir = join(root, 'artifacts/wavetable', `${new Date().toISOString().replaceAll(':', '-')}-${run('git', ['rev-parse', '--short', 'HEAD'], root).trim()}`); mkdirSync(dir, { recursive: true });
  const files = {};
  for (const file of readdirSync(consumer).filter(file => /^candidate-.*\.wav$/.test(file) || ['wavetable-results.json', 'package-lock.json', 'den.tgz'].includes(file))) { copyFileSync(join(consumer, file), join(dir, file)); files[file] = hash(join(dir, file)); }
  const sources = ['src/wavetable.ts', 'src/wavetable-read.ts', 'tests/wavetable-precision.spec.ts', 'tests/fixtures/wavetable-before-local-fraction.ts', 'tests/fixtures/wavetable-bands-before-local-fraction.ts', 'src/virtual-analog.ts', 'src/sample.ts', 'docs/wavetable.md', 'docs/virtual-analog.md', 'tests/wavetable.spec.ts', 'tests/virtual-analog.spec.ts', 'tests/fixtures/wavetable-reference.ts', 'tests/wavetable-packed.test.mjs', 'tests/wavetable-consumer/processor.ts', 'tests/wavetable-consumer/render.mjs', 'package.json', 'package-lock.json'];
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain', '--untracked-files=no'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(file => [file, hash(join(root, file))])), packageIntegrity: pack.integrity, consumerLockHash: hash(join(consumer, 'package-lock.json')), unworklet: '0.4.1', node: process.version,
    publicSubpaths: ['/wavetable', '/virtual-analog'], prerequisiteSubpath: '/sample', sampleRates: [44100, 48000, 96000], frames: 4096, settings: { frameLength: 4096, frameCount: 16, tablePhase: .875, vaPhase: .125, noiseSeed: 2147483646, controls: 'See processor/render source hashes; deterministic ramp morph and PWM, frequency 440+(n%11) after128 held samples, reset1023..1026' }, files,
    verification: 'Independent periodic interpolation, exact raw-waveform convolution, BigInt RNG, maximum resident, strict packed public types and exact same-schema snapshots',
    limitations: ['Not human approved', 'Wavetable is not bandlimited; pulse/triangle retain residual alias', 'No browser or hardware realtime evidence', 'Timing uses unloaded compile driver; PCM copy belongs to native resident ingress', 'No cross-schema migration guarantee'],
  }, null, 2)); console.log(`Wavetable evidence: ${dir}`);
});
