import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConsumer } from './build-consumer.mjs';
export function buildCatalogFixture(build = buildConsumer) {
  return build({ fixture: 'tests/catalog-audition-consumer', stageSite: false });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Built packed catalog fixture: ${buildCatalogFixture().output}`);
}
