import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixtureLocks = [
  'tests/consumer/package-lock.json',
  'tests/integration-consumer/package-lock.json',
  'tests/catalog-audition-consumer/package-lock.json',
  'playground/package-lock.json',
];

export function parseVersion(version) {
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)?.slice(1).map(Number);
  return parts?.every(Number.isSafeInteger) ? parts : undefined;
}

export function prepareVersion(root, version) {
  if (!parseVersion(version) || version === '0.0.0') throw new Error('Use a plain release version greater than 0.0.0 (for example 0.1.0).');
  const read = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const pkg = read('package.json');
  const lock = read('package-lock.json');
  const fixtures = fixtureLocks.map(path => [path, read(path)]);
  // Load and validate all inputs before writing. Registry dependency resolutions
  // and historical candidate evidence are deliberately left unchanged.
  if (pkg.name !== '@denaudio/den' || lock.packages[''].name !== pkg.name) throw new Error('Unexpected package identity.');
  for (const [, fixture] of fixtures) {
    if (fixture.packages['node_modules/@denaudio/den']?.resolved !== 'file:den.tgz') throw new Error('Expected a locked local den tarball.');
    fixture.packages['node_modules/@denaudio/den'].version = version;
  }
  pkg.version = lock.version = lock.packages[''].version = version;
  for (const [path, data] of [['package.json', pkg], ['package-lock.json', lock], ...fixtures]) {
    writeFileSync(resolve(root, path), JSON.stringify(data, null, 2) + '\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareVersion(resolve(import.meta.dirname, '..'), process.argv[2]);
  console.log(`Prepared ${process.argv[2]}. Add its CHANGELOG.md section and review the diff; no tag or publication was created.`);
}
