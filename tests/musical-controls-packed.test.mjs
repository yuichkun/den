import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const reuseInput = process.env.DEN_MUSICAL_CONTROLS_REUSE_LOCKED_CONSUMER;
const treeHashes = (directory, prefix = '') => Object.fromEntries(readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
  const relative = prefix + entry.name, path = join(directory, entry.name);
  if (entry.isDirectory()) return Object.entries(treeHashes(path, `${relative}/`));
  if (entry.isSymbolicLink()) return [[`${relative}@symlink`, readlinkSync(path)]];
  assert(entry.isFile(), `unexpected non-file in installed package: ${path}`);
  return [[relative, hash(path)]];
}));
const dependencyIdentity = directory => {
  const dependencies = {};
  for (const entry of readdirSync(join(directory, 'node_modules'), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const names = entry.name.startsWith('@') ? readdirSync(join(directory, 'node_modules', entry.name)).map(child => `${entry.name}/${child}`) : [entry.name];
    for (const name of names) {
      if (name === '@denaudio/den') continue;
      const actual = realpathSync(join(directory, 'node_modules', name)), files = treeHashes(actual);
      dependencies[name] = { directory: actual, version: JSON.parse(readFileSync(join(actual, 'package.json'), 'utf8')).version, entries: Object.keys(files).length,
        treeSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
    }
  }
  return dependencies;
};
const withoutTarget = lock => ({ ...lock, packages: Object.fromEntries(Object.entries(lock.packages).filter(([name]) => name !== 'node_modules/@denaudio/den')) });
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? join(tmpdir(), 'den-npm-cache') } });
test('packed musical controls: public contracts, independent envelope/LFO references, state and both worklet builds', { timeout: 180000 }, () => {
  assert(!(reuseInput && process.env.CI), 'locked dependency reuse is local-only and forbidden in CI');
  const reuse = reuseInput ? realpathSync(reuseInput) : undefined;
  const trial = `${new Date().toISOString().replaceAll(':', '-')}-${run('git', ['rev-parse', '--short', 'HEAD'], root).trim()}`;
  const output = join(root, 'artifacts/musical-controls', trial); mkdirSync(output, { recursive: true });
  const consumer = mkdtempSync(join(tmpdir(), 'den-musical-controls-'));
  const sources = ['src/modulation.ts', 'src/musical-controls.ts', 'docs/musical-controls-contract.md', 'docs/musical-clock-seek-boundary.md', 'tests/musical-controls.spec.ts', 'tests/musical-clock-seek.spec.ts', 'tests/musical-controls-packed.test.mjs', ...readdirSync(join(root, 'tests/musical-controls-consumer')).map(file => `tests/musical-controls-consumer/${file}`), 'package.json', 'package-lock.json'];
  const sourceIdentity = reuse ? { directory: reuse, tarSha256: hash(join(reuse, 'den.tgz')), lockSha256: hash(join(reuse, 'package-lock.json')), installedTargetHashes: treeHashes(join(reuse, 'node_modules/@denaudio/den')), dependencies: dependencyIdentity(reuse) } : undefined;
  const provenance = { installMode: reuse ? 'reused locked dependencies plus target refresh' : 'fresh npm ci', dependencySource: sourceIdentity, status: 'CANDIDATE', runtime: 'NOT_CLEARED', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '', sourceHashes: Object.fromEntries(sources.map(file => [file, hash(join(root, file))])), consumer, unworklet: '0.4.1', node: process.version };
  writeFileSync(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2));
  let phase = 'prepare';
  try {
    for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', file), join(consumer, file));
    cpSync(join(root, 'tests/musical-controls-consumer'), consumer, { recursive: true });
    phase = 'pack'; const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
    for (const extension of ['js', 'd.ts']) assert(pack.files.some(file => file.path === `dist/musical-controls.${extension}`));
    copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8')); lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity; writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
    phase = 'install';
    if (reuse) {
      const oldLock = JSON.parse(readFileSync(join(reuse, 'package-lock.json'), 'utf8'));
      assert.deepEqual(withoutTarget(oldLock), withoutTarget(lock), 'reused dependency resolutions must match the fixture lock exactly');
      for (const [name, identity] of Object.entries(sourceIdentity.dependencies)) assert.equal(identity.version, oldLock.packages[`node_modules/${name}`]?.version, `installed dependency version ${name}`);
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
    assert.deepEqual(installed.exports['./musical-controls'], { types: './dist/musical-controls.d.ts', import: './dist/musical-controls.js' });
    phase = 'types'; writeFileSync(join(output, 'types.log'), run('node', ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--allowImportingTsExtensions', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'processor.ts', 'lfo-processor.ts'], consumer));
    phase = 'render'; const rendered = run('node', ['render.mjs'], consumer); writeFileSync(join(output, 'render.log'), rendered); console.log(rendered);
    phase = 'build'; writeFileSync(join(output, 'build.log'), run('npm', ['run', 'build'], consumer));
    const assets = readdirSync(join(consumer, 'dist/assets')); assert.equal(assets.filter(file => file.endsWith('.wasm')).length, 2); assert.equal(assets.filter(file => /\.worklet-[^/]+\.js$/.test(file)).length, 2);
    cpSync(join(consumer, 'dist'), join(output, 'build'), { recursive: true });
    const files = {};
    for (const file of readdirSync(consumer).filter(file => file.startsWith('candidate-') || ['musical-controls-results.json', 'package-lock.json', 'den.tgz'].includes(file))) { copyFileSync(join(consumer, file), join(output, file)); files[file] = hash(join(output, file)); }
    writeFileSync(join(output, 'manifest.json'), JSON.stringify({ ...provenance, packageIntegrity: pack.integrity, consumerLockSha256: hash(join(consumer, 'package-lock.json')), publicSubpaths: ['/musical-controls'], offlineSampleRates: [44100, 48000, 96000], browserSampleRates: [], buildSampleRates: [48000], envelopeFrames: 1024, lfoFrames: 2048, files, buildAssets: Object.fromEntries(assets.map(file => [file, hash(join(consumer, 'dist/assets', file))])), verification: 'Strict actual public declarations; independent event-time curved ADSR and exact-integer clock phase references at three rates; free/tempo division endpoints, tiny controls, reset/seek/hold and segment latching; bit-identical control and native-state continuation; fixed loaded memory; cold/warm copy-inclusive diagnostics; zero scrub; two real Vite worklet/WASM builds', limitations: ['Not human approved', 'No browser/device/realtime execution clearance', 'Control signals, not an audio audition or approved sound', 'Public f32 LFO phase quantization and non-bandlimited waves are intentional', 'No maximum-duration ADSR stress render', 'Native snapshots require identical rate and configuration', reuse ? 'Local locked-dependency reuse; this run is not a fresh npm ci proof' : 'Fresh isolated npm ci was used'] }, null, 2));
    console.log(`Musical controls evidence: ${output}`);
  } catch (error) {
    writeFileSync(join(output, 'failure.json'), JSON.stringify({ ...provenance, phase, error: String(error), stdout: error.stdout?.toString(), stderr: error.stderr?.toString() }, null, 2));
    throw error;
  } finally {
    if (reuse) {
      assert.equal(hash(join(reuse, 'den.tgz')), sourceIdentity.tarSha256);
      assert.equal(hash(join(reuse, 'package-lock.json')), sourceIdentity.lockSha256);
      assert.deepEqual(treeHashes(join(reuse, 'node_modules/@denaudio/den')), sourceIdentity.installedTargetHashes);
      assert.deepEqual(dependencyIdentity(reuse), sourceIdentity.dependencies);
      writeFileSync(join(output, 'reuse-source-verification.json'), JSON.stringify({ unchanged: true, archiveSha256: existsSync(join(output, 'reuse-source-installed-den.tgz')) ? hash(join(output, 'reuse-source-installed-den.tgz')) : null, ...sourceIdentity }, null, 2));
    }
  }
});
