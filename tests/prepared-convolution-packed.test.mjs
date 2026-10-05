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
test('packed prepared convolution renders native packets, FIR tails, reset and snapshots', { timeout: 180000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-prepared-convolution-'));
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', file), join(consumer, file));
  cpSync(join(root, 'tests/prepared-convolution-consumer'), consumer, { recursive: true });
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  for (const module of ['prepared-convolution', 'convolution-spectrum', 'spectral-fft']) for (const ext of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/${module}.${ext}`));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  assert.deepEqual(JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'))).exports['./prepared-convolution'], { types: './dist/prepared-convolution.d.ts', import: './dist/prepared-convolution.js' });
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts'] }));
  run('npm', ['run', 'check'], consumer);
  console.log(run('node', ['render.mjs'], consumer));
  console.log(run('npm', ['run', 'build'], consumer));
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], root).trim();
  const path = join(root, 'artifacts/prepared-convolution', new Date().toISOString().replaceAll(':', '-') + '-' + sourceCommit.slice(0, 7)); mkdirSync(path, { recursive: true });
  const files = {};
  for (const file of ['den.tgz', 'package-lock.json', 'prepared-convolution-results.json']) { copyFileSync(join(consumer, file), join(path, file)); files[file] = hash(join(path, file)); }
  const sources = ['src/spectral-fft.ts', 'src/convolution-spectrum.ts', 'src/prepared-convolution.ts', 'docs/prepared-convolution.md', 'tests/prepared-convolution.spec.ts', 'tests/prepared-convolution-packed.test.mjs', 'tests/prepared-convolution-consumer/processor.ts', 'tests/prepared-convolution-consumer/render.mjs', 'tests/prepared-convolution-consumer/vite.config.mjs', 'tests/prepared-convolution-consumer/main.ts', 'tests/prepared-convolution-consumer/index.html', 'tests/probes/convolution-spectrum-f32-ingress.mjs', 'tests/probes/convolution-spectrum-ingress.mjs', 'tests/probes/convolution-spectrum-precision.mjs', 'package.json', 'package-lock.json'];
  writeFileSync(join(path, 'manifest.json'), JSON.stringify({ status: 'CANDIDATE', sourceCommit, sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(file => [file, hash(join(root, file))])),
    packageIntegrity: pack.integrity, node: process.version, unworklet: '0.4.1', offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [], files,
    verified: ['Isolated public typecheck', 'Native prepared Float32 ingress', 'Three-rate original FIR and full8192 impulse tail', 'Load/reset/reject/unload/short replacement and bit-identical snapshots', 'Fixed memory and zero scrubs', 'Maximum16 queued loads', 'Vite worklet compilation'],
    limitations: ['Not human-approved', 'No browser or realtime acceptance', 'Correctness requires unchanged host-prepared packet', '4e-6 preparation rejection certificate; native1e-6/total5e-6 are tested targets only', 'Copy/scan executes at delivery boundary; end-to-end timing is not isolated-handler timing', 'Fixed128/64 and maximum8192 taps only'] }, null, 2));
  console.log(`Prepared convolution public evidence: ${path}`);
});
