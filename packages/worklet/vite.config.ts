import { defineConfig } from "vite";
import { resolve } from "node:path";

const target = process.env.DEN_WORKLET_BUILD ?? "main";

export default defineConfig(() => {
  if (target === "worklet") {
    return {
      build: {
        outDir: "dist",
        emptyOutDir: false, // keep main's output
        lib: {
          entry: resolve(__dirname, "src/processor.ts"),
          formats: ["iife"],
          name: "DenWorkletProcessor",
          fileName: () => "processor.js",
        },
        rollupOptions: { external: [] },
      },
    };
  }
  return {
    build: {
      outDir: "dist",
      lib: {
        entry: resolve(__dirname, "src/index.ts"),
        formats: ["es"],
        fileName: () => "main.js",
      },
      rollupOptions: { external: ["@denaudio/core"] },
    },
  };
});
