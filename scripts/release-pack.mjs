import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkPackage(pack, pkg) {
  assert.equal(pack.name, '@denaudio/den');
  assert.equal(pack.version, pkg.version);
  const files = new Set(pack.files.map(file => file.path));
  for (const path of files) {
    assert(/^(dist\/[^/]+\.(js|d\.ts)|docs\/[^/]+\.(md|json)|package\.json|README\.md|CHANGELOG\.md|LICENSE-MIT|LICENSE-APACHE)$/.test(path), `Unexpected public package file: ${path}`);
  }
  for (const path of ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE-MIT', 'LICENSE-APACHE', 'docs/catalog-status.md']) assert(files.has(path), `Missing ${path}`);
  for (const entry of Object.values(pkg.exports)) {
    for (const condition of ['types', 'import']) assert(files.has(entry[condition].replace(/^\.\//, '')), `Missing export ${entry[condition]}`);
  }
}

function main() {
  const root = resolve(import.meta.dirname, '..');
  const destination = resolve(root, 'artifacts/release');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  // tsc does not remove obsolete output. Publish a fresh build, never stale dist.
  rmSync(resolve(root, 'dist'), { recursive: true, force: true });
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', destination], { cwd: root, encoding: 'utf8' }));
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  checkPackage(pack, pkg);
  const tarball = resolve(destination, pack.filename);
  assert.equal('sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64'), pack.integrity);
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(resolve(destination, 'manifest.json'), JSON.stringify({ name: pack.name, version: pack.version, filename: pack.filename, integrity: pack.integrity, sourceCommit, files: pack.files }, null, 2) + '\n');
  console.log(`Verified ${pack.filename}: ${pack.files.length} public files. No publication performed.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
