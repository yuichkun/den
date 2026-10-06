import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConsumer } from './build-consumer.mjs';
const root = resolve(import.meta.dirname, '..');
// Public output is exclusively the packed code playground. Historical audio
// fixtures remain under tests/ and cannot add routes to this deployment.
export function buildSite({ output = join(root, 'site-dist'), build = buildConsumer } = {}) {
  const playground = build({ fixture: 'playground', stageSite: false });
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  cpSync(playground.output, output, { recursive: true });
  return { output, playground };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Built packed den playground: ${buildSite().output}`);
}
