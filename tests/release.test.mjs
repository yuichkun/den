import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseVersion, prepareVersion } from '../scripts/release-version.mjs';
import { checkRelease, packageVersions, tagsFromRemote } from '../scripts/release-check.mjs';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const read = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const write = (root, path, value) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify(value, null, 2) + '\n');
};
const fixturePaths = [
  'tests/consumer/package-lock.json',
  'tests/integration-consumer/package-lock.json',
  'tests/catalog-audition-consumer/package-lock.json',
  'playground/package-lock.json',
];
const versionFiles = ['package.json', 'package-lock.json', ...fixturePaths];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'den-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = {
    name: '@denaudio/den', version: '0.0.0', license: 'MIT OR Apache-2.0',
    repository: { type: 'git', url: 'git+https://github.com/yuichkun/den.git' },
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
    peerDependencies: { '@unworklet/core': '0.4.1' },
    devDependencies: { '@unworklet/offline': '0.4.1' },
  };
  const dependency = {
    version: '0.4.1', resolved: 'https://registry.npmjs.org/@unworklet/core/-/core-0.4.1.tgz',
    integrity: 'sha512-unchanged-registry-integrity',
  };
  write(root, 'package.json', pkg);
  write(root, 'package-lock.json', {
    name: pkg.name, version: pkg.version, lockfileVersion: 3,
    packages: { '': pkg, 'node_modules/@unworklet/core': dependency },
  });
  for (const path of fixturePaths) write(root, path, {
    name: path.split('/').at(-2), lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@denaudio/den': 'file:./den.tgz', '@unworklet/core': '0.4.1' } },
      'node_modules/@denaudio/den': {
        version: '0.0.0', resolved: 'file:den.tgz', integrity: 'sha512-unchanged-candidate-integrity',
        peerDependencies: pkg.peerDependencies,
      },
      'node_modules/@unworklet/core': dependency,
    },
  });
  write(root, 'docs/historical-candidate.json', { den: '0.0.0', status: 'CANDIDATE' });
  return root;
}

function snapshot(root) {
  return Object.fromEntries([...versionFiles, 'docs/historical-candidate.json'].map(path => [path, readFileSync(join(root, path), 'utf8')]));
}

function release(overrides = {}) {
  return {
    branch: 'release/v0.1.0', sha, sameTree: true,
    versions: Object.fromEntries([...versionFiles, 'package-lock.json root'].map(path => [path, '0.1.0'])),
    tags: {}, changelog: '# Changelog\n\n## 0.1.0 — 2026-10-09\n\nInitial release.\n',
    ...overrides,
  };
}

test('release versions accept plain numeric SemVer and reject alternate or ambiguous forms', () => {
  assert.deepEqual(parseVersion('0.1.0'), [0, 1, 0]);
  assert.deepEqual(parseVersion('12.34.56'), [12, 34, 56]);
  for (const version of [undefined, '', 'v0.1.0', '0.1', '0.1.0.0', '01.1.0', '0.01.0', '0.1.00', '0.1.0-rc.1', '0.1.0+build', ' 0.1.0', '0.1.0\n', '-1.0.0', '9007199254740992.0.0']) {
    assert.equal(parseVersion(version), undefined, String(version));
  }
});

test('version preparation updates only root and four fixture versions, preserving dependencies and candidate evidence', t => {
  const root = fixture(t);
  const before = Object.fromEntries(versionFiles.map(path => [path, read(root, path)]));
  const historical = readFileSync(join(root, 'docs/historical-candidate.json'), 'utf8');
  prepareVersion(root, '0.2.3');
  for (const path of versionFiles) {
    const expected = structuredClone(before[path]);
    if (path === 'package.json') expected.version = '0.2.3';
    else if (path === 'package-lock.json') {
      expected.version = '0.2.3';
      expected.packages[''].version = '0.2.3';
    } else expected.packages['node_modules/@denaudio/den'].version = '0.2.3';
    assert.deepEqual(read(root, path), expected, path);
  }
  assert.equal(readFileSync(join(root, 'docs/historical-candidate.json'), 'utf8'), historical);
  assert.deepEqual(packageVersions(root), Object.fromEntries([...versionFiles, 'package-lock.json root'].map(path => [path, '0.2.3'])));
  const prepared = snapshot(root);
  prepareVersion(root, '0.2.3');
  assert.deepEqual(snapshot(root), prepared, 'Preparing the same version is idempotent.');
});

test('invalid release versions do not write any package or fixture file', t => {
  const root = fixture(t);
  const before = snapshot(root);
  for (const version of [undefined, '', '0.0.0', 'v0.1.0', '0.1.0-rc.1', '0.1.0+build', '01.0.0', '0.1.0\n']) {
    assert.throws(() => prepareVersion(root, version), /plain release version/);
    assert.deepEqual(snapshot(root), before, String(version));
  }
});

test('all version inputs are validated before any writes, including the last fixture', t => {
  const root = fixture(t);
  const originals = snapshot(root);
  const cases = [
    ['package.json', value => { value.name = '@other/package'; }],
    ['package-lock.json', value => { value.packages[''].name = '@other/package'; }],
    [fixturePaths.at(-1), value => { value.packages['node_modules/@denaudio/den'].resolved = 'https://registry.npmjs.org/den.tgz'; }],
    [fixturePaths.at(-1), value => { delete value.packages['node_modules/@denaudio/den']; }],
  ];
  for (const [path, mutate] of cases) {
    for (const [file, contents] of Object.entries(originals)) writeFileSync(join(root, file), contents);
    const value = read(root, path); mutate(value); write(root, path, value);
    const before = snapshot(root);
    assert.throws(() => prepareVersion(root, '0.1.0'));
    assert.deepEqual(snapshot(root), before, path);
  }
  for (const [file, contents] of Object.entries(originals)) writeFileSync(join(root, file), contents);
  writeFileSync(join(root, fixturePaths.at(-1)), '{ invalid json');
  const before = snapshot(root);
  assert.throws(() => prepareVersion(root, '0.1.0'), SyntaxError);
  assert.deepEqual(snapshot(root), before);
});

test('release metadata requires the expected package, public repository and npm destination', t => {
  const root = fixture(t);
  const pkg = read(root, 'package.json');
  for (const mutate of [
    value => { value.name = '@other/package'; },
    value => { value.repository.url = 'git+https://github.com/other/den.git'; },
    value => { value.publishConfig.access = 'restricted'; },
    value => { value.publishConfig.registry = 'https://example.com'; },
  ]) {
    const changed = structuredClone(pkg); mutate(changed); write(root, 'package.json', changed);
    assert.throws(() => packageVersions(root));
  }
});

test('release eligibility requires the exact reviewed tree and release branch version', () => {
  assert.equal(checkRelease(release()), '0.1.0');
  assert.throws(() => checkRelease(release({ sameTree: false })), /reviewed PR head/);
  for (const branch of ['main', 'feature/release/v0.1.0', 'release/0.1.0', 'release/v0.0.0', 'release/v01.1.0', 'release/v0.1.0-rc.1', 'release/v0.1.0+build', 'release/v0.1.0\n']) {
    assert.throws(() => checkRelease(release({ branch })), undefined, branch);
  }
});

test('every package and lock version must match the release branch', () => {
  assert.throws(() => checkRelease(release({ versions: {} })), /No package versions/);
  for (const path of Object.keys(release().versions)) {
    const versions = { ...release().versions, [path]: '0.0.0' };
    assert.throws(() => checkRelease(release({ versions })), /does not match/, path);
  }
});

test('release eligibility requires a changelog section for that exact version', () => {
  for (const changelog of ['', '## 0.1.1 — 2026-10-09\n', '### 0.1.0 — 2026-10-09\n', '## 0.1.0-rc.1 — 2026-10-09\n', 'Mentioning ## 0.1.0 — 2026-10-09 is not a section.']) {
    assert.throws(() => checkRelease(release({ changelog })), /CHANGELOG/);
  }
});

test('existing release tags allow a retry only at the same commit', () => {
  assert.equal(checkRelease(release({ tags: { 'v0.1.0': sha, 'v0.0.1': otherSha } })), '0.1.0');
  assert.throws(() => checkRelease(release({ tags: { 'v0.1.0': otherSha } })), /different commit/);
});

test('newer numeric release tags prevent publishing an older version', () => {
  for (const tag of ['v0.1.1', 'v0.2.0', 'v1.0.0', 'v0.10.0']) {
    assert.throws(() => checkRelease(release({ tags: { [tag]: otherSha } })), /supersedes/, tag);
  }
  assert.equal(checkRelease(release({ tags: { 'v0.0.9': otherSha, 'v2.0.0-rc.1': otherSha, 'demo-v9.0.0': otherSha } })), '0.1.0');
  assert.equal(checkRelease(release({
    branch: 'release/v0.10.0', versions: { 'package.json': '0.10.0' },
    changelog: '## 0.10.0 — 2026-10-09\n', tags: { 'v0.9.0': otherSha },
  })), '0.10.0');
});

test('remote tags resolve annotated tags to their commit regardless of line order', () => {
  const objectSha = 'c'.repeat(40);
  const direct = `${otherSha}\trefs/tags/v0.0.1`;
  const object = `${objectSha}\trefs/tags/v0.1.0`;
  const peeled = `${sha}\trefs/tags/v0.1.0^{}`;
  for (const lines of [[direct, object, peeled], [peeled, direct, object]]) {
    const tags = tagsFromRemote(lines.join('\n') + '\n');
    assert.deepEqual(tags, { 'v0.0.1': otherSha, 'v0.1.0': sha });
    assert.equal(checkRelease(release({ tags })), '0.1.0');
  }
  assert.deepEqual(tagsFromRemote(''), {});
});
