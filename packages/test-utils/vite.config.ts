import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { resolve } from "node:path";

// Multi-entry lib build. Each source module becomes its own `dist/<name>.js`
// so the package can expose `./signals` (browser-safe) and `./node`
// (Node-only, imports `node:fs`) as separate subpath exports. `node:*` is
// marked external so the browser bundle for `./signals` never drags
// `node:fs` / `node:path` into Chromium.
export default defineConfig({
  plugins: [dts({ rollupTypes: false, entryRoot: "src" })],
  build: {
    outDir: "dist",
    target: "esnext",
    sourcemap: true,
    lib: {
      entry: {
        signals: resolve(__dirname, "src/signals.ts"),
        null: resolve(__dirname, "src/null.ts"),
        wav: resolve(__dirname, "src/wav.ts"),
        runner: resolve(__dirname, "src/runner.ts"),
        "signals-entry": resolve(__dirname, "src/signals-entry.ts"),
        "node-entry": resolve(__dirname, "src/node-entry.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: [/^node:/],
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
