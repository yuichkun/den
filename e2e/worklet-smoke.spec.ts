import { test, expect } from "@playwright/test";

test("passthrough worklet renders finite samples for sine input", async ({ page }) => {
  await page.goto("/");

  const ok = await page.evaluate(async () => {
    const w = window as unknown as { __denRunSmoke?: () => Promise<boolean> };
    if (!w.__denRunSmoke) throw new Error("examples entry did not expose __denRunSmoke");
    return await w.__denRunSmoke();
  });

  expect(ok).toBe(true);
});
