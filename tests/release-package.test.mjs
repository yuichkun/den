import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkPackage } from '../scripts/release-pack.mjs';
import { alreadyPublished, waitForPublished } from '../scripts/release-registry.mjs';
import { fixtureLocks, prepareVersion } from '../scripts/release-version.mjs';

const root = resolve(import.meta.dirname, '..');

test('future version packs its public exports and actually renders in a locked external consumer', { timeout: 180000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'den-release-test-'));
  const source = join(directory, 'source');
  const consumer = join(directory, 'consumer');
  const run = (args, cwd) => execFileSync('npm', ['--cache', join(tmpdir(), 'den-npm-cache'), ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    mkdirSync(source);
    for (const path of ['src', 'docs', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'CHANGELOG.md', 'LICENSE-MIT', 'LICENSE-APACHE', ...fixtureLocks]) {
      mkdirSync(resolve(source, path, '..'), { recursive: true });
      cpSync(join(root, path), join(source, path), { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(source, 'node_modules'), 'dir');
    prepareVersion(source, '0.123.4');
    const [pack] = JSON.parse(run(['pack', '--json', '--pack-destination', directory], source));
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    checkPackage(pack, pkg);
    assert.equal(pack.version, '0.123.4');
    assert.throws(() => checkPackage({ ...pack, files: [...pack.files, { path: '.npmrc' }] }, pkg), /Unexpected public package/);
    assert.throws(() => checkPackage({ ...pack, files: pack.files.filter(file => file.path !== 'dist/index.d.ts') }, pkg), /Missing export/);
    cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
    copyFileSync(join(directory, pack.filename), join(consumer, 'den.tgz'));
    const lock = JSON.parse(readFileSync(join(source, 'tests/consumer/package-lock.json'), 'utf8'));
    lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
    writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock));
    run(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
    const installed = JSON.parse(readFileSync(join(consumer, 'node_modules/@denaudio/den/package.json'), 'utf8'));
    assert.equal(installed.version, lock.packages['node_modules/@denaudio/den'].version);
    for (const match of readFileSync(join(consumer, 'node_modules/@denaudio/den/README.md'), 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
      if (!/^[a-z]+:/i.test(match[1]) && !match[1].startsWith('#')) readFileSync(join(consumer, 'node_modules/@denaudio/den', match[1].split('#')[0]));
    }
    run(['run', 'check'], consumer);
    run(['run', 'build'], consumer);
    execFileSync('node', ['render.mjs'], { cwd: consumer, stdio: ['ignore', 'pipe', 'pipe'] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('registry retries require the same tarball and never downgrade a newer release', () => {
  const pack = { name: '@denaudio/den', version: '0.2.0', integrity: 'sha512-expected' };
  const metadata = { name: pack.name, versions: { '0.0.0-stage': {}, '0.1.0': {} } };
  assert.equal(alreadyPublished(metadata, pack), false);
  metadata.versions['0.2.0'] = { dist: { integrity: pack.integrity } };
  assert.equal(alreadyPublished(metadata, pack), true);
  assert.throws(() => alreadyPublished(metadata, { ...pack, integrity: 'sha512-other' }), /different tarball/);
  metadata.versions['0.3.0'] = {};
  assert.throws(() => alreadyPublished(metadata, pack), /newer version/);
  assert.throws(() => alreadyPublished({ ...metadata, name: 'unrelated' }, pack), /Unexpected registry package/);
});

const pack = { name: '@denaudio/den', version: '0.1.0', integrity: 'sha512-expected' };
const missing = { name: pack.name, versions: { '0.0.0-stage': {} } };
const visible = { name: pack.name, versions: { '0.1.0': { dist: { integrity: pack.integrity } } } };

function clock() {
  let time = 0;
  const waits = [];
  return {
    waits,
    options: {
      now: () => time,
      wait: async ms => { waits.push(ms); time += ms; },
      timeoutMs: 25, intervalMs: 10, onPending: () => {},
    },
  };
}

test('verification waits through npm propagation and accepts only the expected tarball', async () => {
  const c = clock();
  const responses = [missing, missing, visible];
  assert.equal(await waitForPublished(pack, { ...c.options, lookup: async () => responses.shift() }), true);
  assert.deepEqual(c.waits, [10, 10]);
  assert.equal(responses.length, 0);
});

test('verification fails at its deadline when npm never exposes the version', async () => {
  const c = clock();
  let lookups = 0;
  await assert.rejects(waitForPublished(pack, { ...c.options, lookup: async () => { lookups++; return missing; } }), /after waiting/);
  assert.equal(lookups, 3);
  assert.deepEqual(c.waits, [10, 10, 5]);
});

test('verification rejects conflicting or superseded releases without waiting', async () => {
  for (const [metadata, error] of [
    [{ ...visible, versions: { '0.1.0': { dist: { integrity: 'sha512-other' } } } }, /different tarball/],
    [{ ...visible, versions: { ...visible.versions, '0.2.0': {} } }, /newer version/],
    [{ ...visible, name: 'unrelated' }, /Unexpected registry package/],
  ]) {
    const c = clock();
    await assert.rejects(waitForPublished(pack, { ...c.options, lookup: async () => metadata }), error);
    assert.deepEqual(c.waits, []);
  }
});

test('verification preserves registry errors instead of treating them as propagation', async () => {
  for (const error of [new Error('npm registry lookup failed (403)'), new Error('network unavailable')]) {
    const c = clock();
    await assert.rejects(waitForPublished(pack, { ...c.options, lookup: async () => { throw error; } }), actual => actual === error);
    assert.deepEqual(c.waits, []);
  }
});

test('an already visible tarball verifies immediately', async () => {
  const c = clock();
  assert.equal(await waitForPublished(pack, { ...c.options, lookup: async () => visible }), true);
  assert.deepEqual(c.waits, []);
});
