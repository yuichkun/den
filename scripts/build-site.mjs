import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConsumer } from './build-consumer.mjs';
import { decoratePage, validateCatalog, writeCatalog } from '../site/build-catalog.mjs';

const root = resolve(import.meta.dirname, '..');
// Only useful listening experiences are deployed. Silent package and old
// Envelope/LFO diagnostics remain independent test fixtures, never public pages.
export function stageSite({ integration, catalog, output = join(root, 'site-dist') }) {
  if (integration.pack.integrity !== catalog.pack.integrity) throw new Error('Site consumers were built from different package bytes');
  validateCatalog(root);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const copy = (source, destination, entryName) => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const from = join(source, entry.name), to = join(destination, entryName && entry.name === 'index.html' ? entryName : entry.name);
      if (entry.isDirectory()) { mkdirSync(to, { recursive: true }); copy(from, to); }
      else {
        if (existsSync(to) && !readFileSync(from).equals(readFileSync(to))) throw new Error(`Conflicting site asset: ${entry.name}`);
        cpSync(from, to);
      }
    }
  };
  copy(integration.output, output, 'playground.html');
  copy(catalog.output, output, 'catalog.html');
  for (const [file, active] of [['playground.html', 'playground'], ['catalog.html', 'listening']]) {
    const path = join(output, file);
    writeFileSync(path, decoratePage(readFileSync(path, 'utf8'), active));
  }
  writeCatalog(root, output);
  return { output, integration, catalog };
}
export function buildSite() {
  const integration = buildConsumer({ fixture: 'tests/integration-consumer', stageSite: false });
  const catalog = buildConsumer({ fixture: 'tests/catalog-audition-consumer', stageSite: false });
  return stageSite({ integration, catalog });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Built den catalog and listening experiences: ${buildSite().output}`); }
  catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}
