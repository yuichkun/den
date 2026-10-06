import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConsumer } from './build-consumer.mjs';
// Standalone development fixture; it cannot populate the public output.
export function buildIntegrationFixture(build = buildConsumer) {
  return build({ fixture: 'tests/integration-consumer', stageSite: false });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Built packed integration fixture: ${buildIntegrationFixture().output}`);
}
