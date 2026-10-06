import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deletion first: remove the previous public UI, routes and generated assets.
// Audio/library verification fixtures are built independently under tests/.
const root = resolve(import.meta.dirname, '..');
export function buildSite({ output = join(root, 'site-dist') } = {}) {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'index.html'), '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>den</title></head><body><main><p>サイトを作り直しています。</p></main></body></html>\n');
  return { output };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Removed previous public site; minimal root at ${buildSite().output}`);
}
