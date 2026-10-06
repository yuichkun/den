import { defineConfig } from 'vite';
import { build } from 'esbuild';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { captureTypeFiles } from './type-files.mjs';
const root = dirname(fileURLToPath(import.meta.url));
let assets;
const vendor = { typescript: 'typescript-5.9.3.mjs', binaryen: 'binaryen-129.mjs' };
export async function playgroundAssets() {
  if (assets) return assets;
  const types = captureTypeFiles();
  const exports = Object.keys(types.packages['@denaudio/den'].exports);
  const examples = [];
  for (const group of readdirSync(join(root, 'examples'), { withFileTypes: true }).filter(item => item.isDirectory())) {
    const folder = join(root, 'examples', group.name);
    for (const entry of JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'))) {
      const source = readFileSync(join(folder, entry.file), 'utf8');
      const specifier = entry.module === '.' ? '@denaudio/den' : `@denaudio/den/${entry.module.slice(2)}`;
      if (!source.includes(`from '${specifier}'`) && !source.includes(`from "${specifier}"`)) throw new Error(`Example does not import its module: ${entry.id}`);
      if (!existsSync(join(root, 'node_modules', '@denaudio/den', 'docs', entry.docs))) throw new Error(`Missing example documentation: ${entry.docs}`);
      examples.push({ ...entry, source });
    }
  }
  const covered = examples.map(item => item.module).sort();
  if (JSON.stringify(covered) !== JSON.stringify(exports.sort())) throw new Error(`Examples must cover every public import exactly once: ${covered.length}/${exports.length}`);
  if (new Set(examples.map(item => item.id)).size !== examples.length) throw new Error('Duplicate example id');
  examples.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const modules = ['@unworklet/core', ...exports.map(key => key === '.' ? '@denaudio/den' : `@denaudio/den/${key.slice(2)}`)];
  const registry = modules.map((name, i) => `import * as m${i} from ${JSON.stringify(name)};`).join('\n') + `\nexport default {${modules.map((name, i) => `${JSON.stringify(name)}:m${i}`).join(',')}};`;
  const bundled = await build({ stdin: { contents: "import { makeWorkletNamespaceFromMeta } from '@unworklet/core/worklet'; globalThis.__uwkMakeNs = makeWorkletNamespaceFromMeta;", resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', minify: true });
  const runtime = bundled.outputFiles[0].text;
  const candidate = existsSync(join(root, 'candidate-provenance.json')) ? JSON.parse(readFileSync(join(root, 'candidate-provenance.json'), 'utf8')) : { sourceIdentity: 'development', sourceCommit: null };
  assets = { types, examples, registry, runtime, candidate };
  return assets;
}
function virtualAssets(emitVendor = false) {
  return {
    name: 'den-packed-playground', enforce: 'pre',
    resolveId(id) { if (Object.hasOwn(vendor, id)) return { id: `/vendor/${vendor[id]}`, external: true }; if (id.startsWith('virtual:den-')) return `\0${id}`; },
    async load(id) {
      if (!id.startsWith('\0virtual:den-')) return;
      const data = await playgroundAssets();
      if (id.endsWith('build')) return `export default ${JSON.stringify(data.candidate)};`;
      if (id.endsWith('types')) return `export default ${JSON.stringify(data.types)};`;
      if (id.endsWith('examples')) return `export default ${JSON.stringify(data.examples)};`;
      if (id.endsWith('modules')) return data.registry;
      if (id.endsWith('runtime')) return `export default ${JSON.stringify(data.runtime)};`;
    },
    async generateBundle() {
      const data = await playgroundAssets();
      if (emitVendor) {
        const ts = await build({ entryPoints: [join(root, 'node_modules/typescript/lib/typescript.js')], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', minify: true, external: ['fs', 'path', 'os', 'crypto', 'perf_hooks', 'inspector'] });
        this.emitFile({ type: 'asset', fileName: `vendor/${vendor.typescript}`, source: ts.outputFiles[0].text });
        const binaryen = fileURLToPath(import.meta.resolve('binaryen'));
        this.emitFile({ type: 'asset', fileName: `vendor/${vendor.binaryen}`, source: readFileSync(binaryen) });
      }
      this.emitFile({ type: 'asset', fileName: 'provenance.json', source: JSON.stringify({
        candidate: data.candidate,
        packages: data.types.packages, declarationHashes: data.types.hashes,
        examples: data.examples.map(({ id, module, source }) => ({ id, module, sha256: createHash('sha256').update(source).digest('hex') })),
        runtimeSHA256: createHash('sha256').update(data.runtime).digest('hex'),
      }, null, 2) });
    },
  };
}
export default defineConfig({
  plugins: [virtualAssets(true)],
  worker: { format: 'es', plugins: () => [virtualAssets()] },
  build: { target: 'es2022', sourcemap: false, reportCompressedSize: false, chunkSizeWarningLimit: 14000 },
});
