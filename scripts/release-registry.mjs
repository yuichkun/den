import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseVersion } from './release-version.mjs';

// A retry may skip only the identical tarball. Never treat an authentication or
// network failure as "not published", or overwrite a newer dist-tag with an old run.
export function alreadyPublished(metadata, pack) {
  assert.equal(metadata.name, pack.name, 'Unexpected registry package.');
  const version = parseVersion(pack.version);
  assert(version, 'Expected a plain release version.');
  for (const candidate of Object.keys(metadata.versions ?? {})) {
    const other = parseVersion(candidate);
    if (!other) continue; // npm's bootstrap placeholder is 0.0.0-stage.
    assert((other[0] - version[0] || other[1] - version[1] || other[2] - version[2]) <= 0, `npm already has newer version ${candidate}.`);
  }
  const existing = metadata.versions?.[pack.version];
  if (!existing) return false;
  assert.equal(existing.dist?.integrity, pack.integrity, 'This npm version contains a different tarball; it cannot be replaced.');
  return true;
}

async function registryMetadata() {
  const response = await fetch('https://registry.npmjs.org/@denaudio%2Fden', {
    headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30000),
  });
  assert(response.status !== 404, 'Create the npm package and configure trusted publishing first. See RELEASE.md.');
  assert(response.ok, `npm registry lookup failed (${response.status}).`);
  return response.json();
}

// npm can accept a publish before the new version becomes visible in metadata.
// Wait only for an absent version: collisions, newer versions and lookup errors
// remain immediate failures. Each request retains its own 30-second timeout.
export async function waitForPublished(pack, {
  lookup = registryMetadata, wait = delay, now = () => performance.now(),
  timeoutMs = 300000, intervalMs = 10000,
  onPending = () => console.log(`Waiting for npm to expose ${pack.name}@${pack.version}...`),
} = {}) {
  assert(timeoutMs > 0 && intervalMs > 0, 'Publication wait limits must be positive.');
  const deadline = now() + timeoutMs;
  do {
    if (alreadyPublished(await lookup(), pack)) return true;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    onPending();
    await wait(Math.min(intervalMs, remaining));
  } while (now() < deadline);
  assert.fail('The expected tarball is not present on npm after waiting for registry propagation.');
}

async function main() {
  const pack = JSON.parse(readFileSync('artifacts/release/manifest.json', 'utf8'));
  assert.equal(pack.name, '@denaudio/den');
  const published = process.argv.includes('--verify')
    ? await waitForPublished(pack)
    : alreadyPublished(await registryMetadata(), pack);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `published=${published}\n`);
  console.log(published ? 'npm already contains this exact tarball.' : 'This version is not yet on npm.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
