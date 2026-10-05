import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConsumer } from './build-consumer.mjs';

// All routes are built from the same packed package in isolated locked consumers.
// Keep the silent entry gate and the earlier module audition alongside the
// initial instrument/FX candidate. No hosting/project/access settings are changed.
export function buildSite() {
  const diagnostic = buildConsumer();
  const integration = buildConsumer({fixture: 'tests/integration-consumer', stageSite: false});
  const catalog = buildConsumer({fixture: 'tests/catalog-audition-consumer', stageSite: false});
  if (diagnostic.pack.integrity !== integration.pack.integrity || diagnostic.pack.integrity !== catalog.pack.integrity) {
    throw new Error('Site consumers were built from different package bytes');
  }
  const output = diagnostic.output;
  renameSync(join(output, 'index.html'), join(output, 'diagnostics.html'));
  const copy = (source, destination) => {
    for (const entry of readdirSync(source, {withFileTypes: true})) {
      const from = join(source, entry.name), to = join(destination, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(to, {recursive: true}); copy(from, to);
      } else {
        if (existsSync(to) && !readFileSync(from).equals(readFileSync(to))) {
          throw new Error(`Conflicting site asset: ${entry.name}`);
        }
        cpSync(from, to);
      }
    }
  };
  copy(integration.output, output);
  renameSync(join(catalog.output, 'index.html'), join(catalog.output, 'catalog.html'));
  copy(catalog.output, output);
  // Standalone consumers retain their own root navigation; only staged site
  // pages know that the silent gate moved away from the root.
  const auditionPath = join(output, 'audition.html');
  const audition = readFileSync(auditionPath, 'utf8');
  const oldLink = '<a href="/">Silent entry check</a>';
  if (!audition.includes(oldLink)) throw new Error('Missing module-audition return link');
  writeFileSync(auditionPath, audition.replace(oldLink, '<a href="/diagnostics.html">Silent entry check</a>'));
  const indexPath = join(output, 'index.html');
  const index = readFileSync(indexPath, 'utf8');
  if (!index.includes('</main>')) throw new Error('Missing integration page main element');
  writeFileSync(indexPath, index.replace('</main>', '<p><a href="/diagnostics.html">Silent package check</a> · <a href="/audition.html">Envelope / LFO diagnostic</a> · <a href="/catalog.html">Catalog A/B audition</a></p></main>'));
  const catalogPath = join(output, 'catalog.html');
  const catalogHtml = readFileSync(catalogPath, 'utf8');
  if (!catalogHtml.includes('</main>')) throw new Error('Missing catalog page main element');
  writeFileSync(catalogPath, catalogHtml.replace('</main>', '<p><a href="/">Initial sound / FX candidate</a> · <a href="/diagnostics.html">Silent package check</a> · <a href="/audition.html">Envelope / LFO diagnostic</a></p></main>'));
  return {output, diagnostic, integration, catalog};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Built initial den candidate and diagnostics: ${buildSite().output}`); }
  catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}
