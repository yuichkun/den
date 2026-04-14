import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    trace: "on-first-retry",
    baseURL: "http://127.0.0.1:4173",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command:
      'sh -c "vp run build && pnpm --dir packages/examples exec vite preview --host 127.0.0.1 --strictPort --port 4173"',
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
});
