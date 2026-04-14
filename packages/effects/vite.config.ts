import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { resolve } from "node:path";

// `vite-plugin-dts` emits dist/index.d.ts so consumers (incl. Sub D's
// new effects subclasses) get types against the published "types" entry.
export default defineConfig({
  plugins: [dts({ rollupTypes: true, entryRoot: "src" })],
  build: {
    outDir: "dist",
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: ["@denaudio/core", "@denaudio/worklet"],
    },
  },
});
