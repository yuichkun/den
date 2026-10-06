import { defineConfig } from "vite";
import { build } from "esbuild";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = import.meta.dirname;
let runtime;
function assets(emit = false) {
  return {
    name: "den-kit-native-runtime",
    enforce: "pre",
    resolveId(id) {
      if (id === "binaryen") return { id: "/vendor/binaryen-129.mjs", external: true };
      if (id.startsWith("virtual:den-kit-")) return "\0" + id;
    },
    async load(id) {
      if (id === "\0virtual:den-kit-runtime") {
        runtime ??= (
          await build({
            stdin: {
              contents:
                "import {makeWorkletNamespaceFromMeta} from '@unworklet/core/worklet'; globalThis.__uwkMakeNs=makeWorkletNamespaceFromMeta;",
              resolveDir: root,
            },
            bundle: true,
            write: false,
            platform: "browser",
            format: "iife",
            target: "es2022",
            minify: true,
          })
        ).outputFiles[0].text;
        return `export default ${JSON.stringify(runtime)}`;
      }
      if (id === "\0virtual:den-kit-build")
        return `export default ${existsSync(join(root, "candidate-provenance.json")) ? readFileSync(join(root, "candidate-provenance.json"), "utf8") : '{"sourceCommit":null,"sourceDirty":null,"packageIntegrity":null}'}`;
    },
    generateBundle() {
      if (emit)
        this.emitFile({
          type: "asset",
          fileName: "vendor/binaryen-129.mjs",
          source: readFileSync(fileURLToPath(import.meta.resolve("binaryen"))),
        });
    },
  };
}
export default defineConfig({
  plugins: [assets(true)],
  worker: { format: "es", plugins: () => [assets()] },
  build: { target: "es2022", reportCompressedSize: false },
  server: { host: "127.0.0.1" },
});
