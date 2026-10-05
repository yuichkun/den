import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConsumer } from './build-consumer.mjs';

// Both routes are built from the same packed package in isolated locked consumers.
// Keep the silent entry gate and the earlier module audition alongside the
// initial instrument/FX candidate. No hosting/project/access settings are changed.
export function buildSite() {
  const diagnostic = buildConsumer();
  const integration = buildConsumer({fixture: 'tests/integration-consumer', stageSite: false});
  if (diagnostic.pack.integrity !== integration.pack.integrity) {
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
  return {output, diagnostic, integration};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Built initial den candidate and diagnostics: ${buildSite().output}`); }
  catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}
