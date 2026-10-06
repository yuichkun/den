import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const reuseInput = process.env.DEN_SPATIAL_CHAINS_REUSE_LOCKED_CONSUMER;
const treeHashes = (directory, prefix = '') => Object.fromEntries(readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
  const relative = prefix + entry.name, path = join(directory, entry.name);
  if (entry.isDirectory()) return Object.entries(treeHashes(path, `${relative}/`));
  assert(entry.isFile(), `unexpected non-file in installed target package: ${path}`);
  return [[relative, hash(path)]];
}));
const withoutTarget = lock => ({ ...lock, packages: Object.fromEntries(Object.entries(lock.packages).filter(([name]) => name !== 'node_modules/@denaudio/den')) });
// All regular package bytes and internal symlink targets are fingerprinted.
// Root .bin shims are shared read-only; newly generated caches stay private.
const dependencyTrees = directory => {
  const digest = path => {
    const value = createHash('sha256');
    const visit = (at, prefix = '') => {
      for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = join(at, entry.name), relative = prefix + entry.name;
        if (entry.isDirectory()) { value.update(`dir:${relative}\0`); visit(file, `${relative}/`); }
        else if (entry.isSymbolicLink()) value.update(`link:${relative}\0${readlinkSync(file)}\0`);
        else { assert(entry.isFile()); value.update(`file:${relative}\0${hash(file)}\0`); }
      }
    };
    visit(path); return value.digest('hex');
  };
  const result = {};
  for (const name of readdirSync(directory).filter(name => !name.startsWith('.')).sort()) {
    const names = name.startsWith('@') ? readdirSync(join(directory, name)).filter(child => !child.startsWith('.')).sort().map(child => `${name}/${child}`) : [name];
    for (const key of names) if (key !== '@denaudio/den') {
      const path = realpathSync(join(directory, key)); result[key] = { realpath: path, sha256: digest(path) };
    }
  }
  return result;
};
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? join(tmpdir(), 'den-npm-cache') } });
test('packed spatial chains: independent FIR/FDN/pitch equations, native state and both worklet builds', { timeout: 180000 }, () => {
  assert(!(reuseInput && process.env.CI), 'locked dependency reuse is local-only and forbidden in CI');
  const reuse = reuseInput ? realpathSync(reuseInput) : undefined;
  const trial = `${new Date().toISOString().replaceAll(':', '-')}-${run('git', ['rev-parse', '--short', 'HEAD'], root).trim()}`;
  const output = join(root, 'artifacts/spatial-chains', trial); mkdirSync(output, { recursive: true });
  const consumer = mkdtempSync(join(tmpdir(), 'den-spatial-chains-'));
  const sources = ['src/spatial-chains.ts', 'src/convolution.ts', 'src/spectral-fft.ts', 'src/stereo-delay.ts', 'src/delay-readhead.ts', 'src/reverb.ts', 'src/windowed-pitch-shift.ts', 'docs/spatial-chains-entry.md', 'tests/spatial-chains.spec.ts', 'tests/fixtures/spatial-chains-reference.ts', 'tests/fixtures/windowed-pitch-shift-reference.ts', 'tests/spatial-chains-packed.test.mjs', ...readdirSync(join(root, 'tests/spatial-chains-consumer')).map(file => `tests/spatial-chains-consumer/${file}`), 'package.json', 'package-lock.json'];
  const sourceIdentity = reuse ? { directory: reuse, tarSha256: hash(join(reuse, 'den.tgz')), lockSha256: hash(join(reuse, 'package-lock.json')), installedTargetHashes: treeHashes(join(reuse, 'node_modules/@denaudio/den')), nonTargetDependencies: dependencyTrees(join(reuse, 'node_modules')) } : undefined;
  const provenance = { installMode: reuse ? 'reused locked dependencies plus target refresh' : 'fresh npm ci', dependencySource: sourceIdentity, status: 'CANDIDATE', runtime: 'NOT_CLEARED', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(file => [file, hash(join(root, file))])), consumer, unworklet: '0.4.1', node: process.version };
  writeFileSync(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2));
  let phase = 'prepare';
  try {
    for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', file), join(consumer, file));
    cpSync(join(root, 'tests/spatial-chains-consumer'), consumer, { recursive: true });
    writeFileSync(join(consumer, 'reference.ts'), readFileSync(join(root, 'tests/fixtures/spatial-chains-reference.ts'), 'utf8').replace('./windowed-pitch-shift-reference.js', './pitch-reference.ts'));
    copyFileSync(join(root, 'tests/fixtures/windowed-pitch-shift-reference.ts'), join(consumer, 'pitch-reference.ts'));
    phase = 'pack'; const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
    for (const extension of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/spatial-chains.${extension}`));
    copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8')); lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity; writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
    phase = 'install';
    if (reuse) {
      const oldLock = JSON.parse(readFileSync(join(reuse, 'package-lock.json'), 'utf8'));
      assert.deepEqual(withoutTarget(oldLock), withoutTarget(lock), 'reused dependency resolutions must match the fixture lock exactly');
      copyFileSync(join(reuse, 'den.tgz'), join(output, 'reuse-source-den.tgz'));
      copyFileSync(join(reuse, 'package-lock.json'), join(output, 'reuse-source-package-lock.json'));
      run('tar', ['-czf', join(output, 'reuse-source-installed-den.tgz'), '-C', join(reuse, 'node_modules/@denaudio'), 'den'], root);
      const destination = join(consumer, 'node_modules'); mkdirSync(destination, { recursive: true });
      // Only executable shims and dependency entries are shared. Caches and the
      // source's hidden lock stay private; den is extracted into our own folder.
      for (const entry of readdirSync(join(reuse, 'node_modules'), { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.bin') continue;
        const source = join(reuse, 'node_modules', entry.name), target = join(destination, entry.name);
        if (entry.name.startsWith('@')) {
          mkdirSync(target, { recursive: true });
          for (const child of readdirSync(source)) {
            if (entry.name === '@denaudio' && child === 'den' || child.startsWith('.')) continue;
            symlinkSync(join(source, child), join(target, child), 'dir');
          }
        } else symlinkSync(source, target, 'dir');
      }
      const target = join(destination, '@denaudio/den'); mkdirSync(target, { recursive: true });
      run('tar', ['-xzf', join(consumer, 'den.tgz'), '-C', target, '--strip-components=1'], root);
      writeFileSync(join(output, 'install.log'), 'LOCAL ONLY: reused unchanged locked dependency entries; extracted only @denaudio/den from the actual new packed tarball. No npm ci or dependency installation performed.\n');
    } else writeFileSync(join(output, 'install.log'), run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer));
    const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'), 'utf8'));
    assert.deepEqual(installed.exports['./spatial-chains'], { types: './dist/spatial-chains.d.ts', import: './dist/spatial-chains.js' });
    phase = 'types'; writeFileSync(join(output, 'types.log'), run('node', ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--allowImportingTsExtensions', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'processor.ts', 'pitched-processor.ts'], consumer));
    phase = 'render'; const rendered = run('node', ['render.mjs'], consumer); writeFileSync(join(output, 'render.log'), rendered); console.log(rendered);
    phase = 'build'; writeFileSync(join(output, 'build.log'), run('npm', ['run', 'build'], consumer));
    const assets = readdirSync(join(consumer, 'dist/assets'));
    assert(assets.filter(file => file.endsWith('.wasm')).length >= 2, 'both distinct public compositions must emit WASM');
    assert(assets.filter(file => /worklet.*\.js$/.test(file)).length >= 2, 'both public compositions must emit worklets');
    cpSync(join(consumer, 'dist'), join(output, 'build'), { recursive: true });
    const files = {};
    for (const file of readdirSync(consumer).filter(file => file.startsWith('candidate-') || ['spatial-chains-results.json', 'package-lock.json', 'den.tgz'].includes(file))) { copyFileSync(join(consumer, file), join(output, file)); files[file] = hash(join(output, file)); }
    writeFileSync(join(output, 'manifest.json'), JSON.stringify({ ...provenance, packageIntegrity: pack.integrity, consumerLockSha256: hash(join(consumer, 'package-lock.json')), publicSubpaths: ['/spatial-chains'], offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [], buildSampleRates: [48000], frames: 32768, files, buildAssets: Object.fromEntries(assets.map(file => [file, hash(join(consumer, 'dist/assets', file))])), verification: 'Strict isolated public types, direct FIR/tap and expanded FDN/pitch equations at three rates, native a-rate parameters and exact same-schema PCM/state continuation, fixed maximum memory and pitched first arrivals, zero scrubbing and both Vite worklet/WASM builds', limitations: ['Not human approved', 'No actual browser/device/realtime execution clearance', 'Feedforward pitched output, not regenerative feedback shimmer', 'Finite normalized input only; no normalization or limiter', 'Dry is immediate; early and late paths have different delays', 'Windowed pitch may alias, cancel or retain the wrong dominant pitch', 'IIR tail has no exact finite drain; candidate files are finite excerpts', 'Native state and AudioParam restore are not atomic'] }, null, 2));
    if (reuse) {
      assert.equal(hash(join(reuse, 'den.tgz')), sourceIdentity.tarSha256);
      assert.equal(hash(join(reuse, 'package-lock.json')), sourceIdentity.lockSha256);
      assert.deepEqual(treeHashes(join(reuse, 'node_modules/@denaudio/den')), sourceIdentity.installedTargetHashes);
      assert.deepEqual(dependencyTrees(join(reuse, 'node_modules')), sourceIdentity.nonTargetDependencies, 'all reused non-target dependency bytes must remain unchanged');
      writeFileSync(join(output, 'reuse-source-verification.json'), JSON.stringify({ unchanged: true, archiveSha256: hash(join(output, 'reuse-source-installed-den.tgz')), ...sourceIdentity }, null, 2));
    }
    console.log(`Spatial chain evidence: ${output}`);
  } catch (error) {
    writeFileSync(join(output, 'failure.json'), JSON.stringify({ ...provenance, phase, error: String(error), stdout: error.stdout?.toString(), stderr: error.stderr?.toString() }, null, 2));
    throw error;
  }
});
