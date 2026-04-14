import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: "http://localhost:5173" },
  webServer: {
    // `vp run --filter <pkg> <script>` (or `-F`) invokes the package's
    // script with the workspace filter applied. The flag MUST come
    // before the script name; `vp run dev --filter <pkg>` is parsed as
    // `vp run dev` with `--filter` passed THROUGH to the script and
    // fails with "Task 'dev' not found" — a Vite+ args-parsing quirk
    // we hit more than once during Sub C. `vp dev --filter` is
    // separately undocumented and should not be used either.
    command: "vp run --filter @denaudio/examples dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
