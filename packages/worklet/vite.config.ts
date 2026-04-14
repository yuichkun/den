import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { resolve } from "node:path";

const target = process.env.DEN_WORKLET_BUILD ?? "main";

// Two passes selected by env var (kept from issue #3 §6.4 build shape):
//   - target=main:    main-thread ESM + dist/main.d.ts (consumer-facing)
//   - target=worklet: classic IIFE for `audioWorklet.addModule(...)`, no .d.ts
export default defineConfig(
  target === "worklet"
    ? {
        build: {
          outDir: "dist",
          emptyOutDir: false, // keep main's output (main.js + main.d.ts)
          lib: {
            entry: resolve(__dirname, "src/processor.ts"),
            formats: ["iife"],
            name: "DenWorkletProcessor",
            fileName: () => "processor.js",
          },
          rollupOptions: { external: [] },
        },
      }
    : {
        plugins: [
          dts({
            rollupTypes: true,
            entryRoot: "src",
            // The IIFE worklet build is consumed by `audioWorklet.addModule(url)`
            // as a classic script — never imported, never typechecked. Skip it
            // so we don't ship a useless processor.d.ts.
            exclude: ["src/processor.ts"],
          }),
        ],
        build: {
          outDir: "dist",
          lib: {
            entry: resolve(__dirname, "src/index.ts"),
            formats: ["es"],
            fileName: () => "main.js",
          },
          rollupOptions: { external: ["@denaudio/core"] },
        },
      },
);
