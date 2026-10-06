import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { preview } from "vite";
import { buildDenKit } from "./build-den-kit.mjs";
const root = resolve(import.meta.dirname, "..");
const local = process.argv.includes("--existing-output");
const artifacts = join(root, "artifacts/den-kit", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(artifacts, { recursive: true });
const manifest = {
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceDirty:
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "",
  scope: local ? "existing-local-build" : "isolated-packed-package",
  completed: false,
  checks: [],
  measurements: [],
  listening: "NOT_PERFORMED",
};
let built, server, browser;
try {
  built = local ? { output: join(root, "den-kit/dist") } : buildDenKit();
  manifest.packageIntegrity = built.provenance?.packageIntegrity;
  if (!local)
    manifest.checks.push(
      "locked isolated packed-package typecheck, graph validation and native numerical audio tests",
    );
  server = await preview({
    root,
    configFile: false,
    build: { outDir: built.output },
    preview: { host: "127.0.0.1", port: 0 },
  });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  const url = server.resolvedUrls.local[0];
  await page.goto(url);
  await page.waitForFunction(() => !!window.__denKit);
  const state = () => page.evaluate(() => window.__denKit.state());
  const start = async () => {
    await page.click("#apply");
    await page.waitForFunction(
      () => ["playing", "error"].includes(window.__denKit.state().phase),
      undefined,
      { timeout: 45000 },
    );
    const s = await state();
    assert.equal(s.phase, "playing", s.error);
  };
  const stop = async () => {
    await page.click("#stop");
    await page.waitForFunction(() => {
      const s = window.__denKit.state();
      return s.phase === "idle" && s.created === s.closed;
    });
    assert.equal((await state()).peak, 0);
  };
  assert.equal((await state()).created, 0);
  assert.equal(await page.locator(".module").count(), 8);
  assert.equal(await page.locator(".palette-module").count(), 9);
  if (!local) {
    assert.equal((await state()).build.sourceCommit, manifest.sourceCommit);
    assert.equal((await state()).build.packageIntegrity, manifest.packageIntegrity);
  }
  await page.screenshot({ path: join(artifacts, "desktop.png") });
  await start();
  assert((await state()).rms < 1e-6, "Keyboard patch must be silent before notes");
  await page.keyboard.down("a");
  await page.waitForTimeout(250);
  const key = await state();
  assert(key.finite && key.rms > 0.002, "A real keyboard gesture must produce native audio");
  manifest.measurements.push({ check: "keyboard-down", rms: key.rms, peak: key.peak });
  await page.keyboard.up("a");
  await page.waitForTimeout(2200);
  assert((await state()).rms < 0.001, "Released note and delay tail must decay");
  await page.keyboard.down("s");
  await page.waitForTimeout(150);
  await page.click("#panic");
  await page.keyboard.up("s");
  await page.waitForTimeout(100);
  assert((await state()).peak < 1e-6);
  await page.keyboard.down("d");
  await page.waitForTimeout(180);
  assert((await state()).rms > 0.002);
  await page.keyboard.up("d");
  await stop();
  manifest.checks.push("keyboard notes/release and Panic use native DSP; no autoplay");
  await page.selectOption("#preset", "1");
  await start();
  await page.waitForTimeout(500);
  const drone = await state();
  assert(drone.rms > 0.002 && drone.finite);
  manifest.measurements.push({ check: "drone", rms: drone.rms, peak: drone.peak });
  await page.click("#panic");
  await page.evaluate(() => window.__denKit.engine.note(48, false));
  await page.waitForTimeout(100);
  assert.equal((await state()).panicked, true);
  assert.equal((await state()).peak, 0, "A late noteOff must not unmute a panicked drone");
  await page.evaluate(() => window.__denKit.engine.note(48, true));
  await page.waitForTimeout(100);
  assert((await state()).rms > 0.002);
  await page.locator("#volume").focus();
  await page.keyboard.press("Home");
  await page.waitForTimeout(200);
  assert((await state()).peak < 1e-6);
  for (let i = 0; i < 25; i++) await page.keyboard.press("ArrowRight");
  const frequency = page.getByRole("spinbutton", { name: "osc Frequency", exact: true });
  await frequency.fill("440");
  await frequency.press("Tab");
  assert.equal((await state()).patch.nodes.find((n) => n.id === "osc").params.frequency, 440);
  assert.equal((await state()).phase, "playing");
  // Actual port interaction: remove then reconnect the only output cable.
  await page.locator('[data-edge="e5"]').focus();
  await page.keyboard.press("Delete");
  assert.equal((await state()).patch.edges.length, 5);
  await start();
  await page.waitForTimeout(100);
  assert.equal((await state()).peak, 0, "Disconnected graph has no hidden audio route");
  await page.getByRole("button", { name: "Output echo Stereo", exact: true }).click();
  await page.getByRole("button", { name: "Input out In", exact: true }).click();
  assert.equal((await state()).patch.edges.length, 6);
  await start();
  await page.waitForTimeout(300);
  assert((await state()).rms > 0.002);
  manifest.checks.push(
    "real cable deletion/reconnection changes compiled audio; native live parameter/master controls",
  );
  // Dragging changes only layout; undo restores it, without a context rebuild.
  const before = await state();
  const header = page.locator('.module[data-id="osc"] .module-header');
  const box = await header.boundingBox();
  assert(box);
  await page.mouse.move(box.x + 60, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 92, box.y + 44, { steps: 6 });
  await page.mouse.up();
  const moved = await state();
  assert.notEqual(moved.patch.nodes[0].x, before.patch.nodes[0].x);
  assert.equal(moved.created, before.created);
  await page.click("#undo");
  assert.equal((await state()).patch.nodes[0].x, before.patch.nodes[0].x);
  await page.click("#redo");
  assert.equal((await state()).patch.nodes[0].x, moved.patch.nodes[0].x);
  const saved = (await state()).patch;
  await page.locator("#file").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":99}'),
  });
  assert.deepEqual((await state()).patch, saved);
  assert.equal(
    (await state()).phase,
    "playing",
    "Invalid imports leave the current patch/audio alone",
  );
  await page.locator("#file").setInputFiles({
    name: "patch.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await page.waitForFunction(() => window.__denKit.state().phase === "idle");
  assert.deepEqual((await state()).patch, saved);
  const downloadPromise = page.waitForEvent("download");
  await page.click("#export");
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "den-kit-patch.json");
  await download.saveAs(join(artifacts, "exported-patch.json"));
  manifest.checks.push(
    "drag/undo/redo preserve DSP identity; invalid import is non-destructive; valid import/export round-trip",
  );
  // Stop cancels a compilation; a result completing later cannot resurrect audio.
  await page.click("#apply");
  await page.click("#stop");
  await page.waitForTimeout(800);
  assert.equal((await state()).phase, "idle");
  assert.equal((await state()).created, (await state()).closed);
  await start();
  await stop();
  // Multiple restart gestures serialize the prior close, and only the newest
  // request may own audio. Stop also cancels a restart waiting for disposal.
  await page.click("#apply");
  await page.click("#apply");
  await page.waitForFunction(() => window.__denKit.state().phase === "playing", undefined, {
    timeout: 45000,
  });
  assert.equal((await state()).created - (await state()).closed, 1);
  await page.click("#apply");
  await page.click("#stop");
  await page.waitForFunction(() => {
    const s = window.__denKit.state();
    return s.phase === "idle" && s.created === s.closed;
  });
  await page.waitForTimeout(300);
  assert.equal((await state()).phase, "idle");
  await start();
  await page.goto("about:blank");
  await page.goto(url);
  await page.waitForFunction(() => !!window.__denKit);
  assert.equal((await state()).created, 0);
  manifest.checks.push(
    "repeat Apply/Stop, cancellation and navigation never leave or restart a stale session",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, "mobile.png") });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await page.locator("#apply").isVisible(), true);
  assert.equal(await page.locator("#stop").isVisible(), true);
  assert.deepEqual(errors, []);
  manifest.checks.push("desktop/mobile viewport containment and no browser exceptions");
  manifest.completed = true;
} catch (error) {
  manifest.failure = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  writeFileSync(join(artifacts, "manifest.json"), JSON.stringify(manifest, null, 2));
  await browser?.close();
  await server?.httpServer.close();
  if (built?.consumer) rmSync(built.consumer, { recursive: true, force: true });
  console.log(`den-kit browser evidence: ${artifacts}`);
}
