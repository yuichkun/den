import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { resolve } from "node:path";

// Vite builds ONLY the TS loader (index.ts) here. The WASM binary is
// produced by scripts/build-wasm.mjs which copies den_core.wasm directly
// into dist/ alongside index.js — Vite never touches the .wasm. This
// avoids the lib-mode `?url` unreliability (vitejs/vite#3295) and keeps
// the build deterministic.
//
// `vite-plugin-dts` emits index.d.ts so consumers (incl. workspace
// packages typechecking against `./dist/index.d.ts`) get types.
export default defineConfig({
  plugins: [dts({ rollupTypes: true, entryRoot: "src" })],
  build: {
    outDir: "dist",
    emptyOutDir: false, // don't wipe den_core.wasm (placed by prebuild)
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: [],
    },
  },
});
