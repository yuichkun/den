import { defineConfig } from "vite";
import { resolve } from "node:path";

// Note: this Vite config builds ONLY the TS loader (index.ts).
// The WASM binary is produced by scripts/build-wasm.mjs which copies
// den_core.wasm directly into dist/ alongside index.js — Vite never
// touches the .wasm. This avoids the lib-mode `?url` unreliability
// (vitejs/vite#3295) and keeps the build deterministic.
export default defineConfig({
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
