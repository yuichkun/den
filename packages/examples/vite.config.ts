import { defineConfig } from "vite";

// Port comes from `package.json` `dev` script (`vite --port 5273`) so
// CLI override and Playwright config are the single source of truth.
// Don't set it here too — `vite.config.ts.server.port` would shadow on
// any `vp run dev` invocation that drops the explicit `--port`, leading
// to silent drift between this file and `playwright.config.ts`.
export default defineConfig({
  server: { host: true },
  build: { outDir: "dist", target: "esnext", sourcemap: true },
});
