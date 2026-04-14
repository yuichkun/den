/// <reference types="node" />
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import "../src/test-bridge.js";

test.describe("Tier3a: Passthrough through AudioWorklet", () => {
  for (const sig of ["chirp", "sine_1k", "impulse"]) {
    test(`null test against golden (${sig})`, async ({ page }) => {
      page.on("pageerror", (err) => console.log("pageerror:", err.message));
      await page.goto("/#/passthrough");
      await page.waitForFunction(() => Boolean(window.__denReady));
      const result = await page.evaluate(async (signalName) => {
        const api = window.__denTier3a;
        if (!api) throw new Error("__denTier3a missing — page not ready");
        const { Passthrough, CANONICAL, workletUrl } = api;
        const factory = CANONICAL[signalName];
        if (!factory) throw new Error(`unknown signal: ${signalName}`);
        const inSig = factory();
        const ctx = new OfflineAudioContext({
          numberOfChannels: 2,
          length: inSig.length,
          sampleRate: 48000,
        });
        await Passthrough.register(ctx, { workletUrl });
        const node = await Passthrough.create(ctx, { workletUrl });
        const src = ctx.createBufferSource();
        const buf = ctx.createBuffer(2, inSig.length, 48000);
        const stereo = new Float32Array(inSig.length);
        stereo.set(inSig);
        buf.copyToChannel(stereo, 0);
        buf.copyToChannel(stereo, 1);
        src.buffer = buf;
        src.connect(node).connect(ctx.destination);
        src.start();
        const rendered = await ctx.startRendering();
        return Array.from(rendered.getChannelData(0));
      }, sig);

      expect(result.length).toBeGreaterThan(0);
      const { readWavF32, rmsDiffDbFs } = await import("@denaudio/test-utils/node");
      const golden = readWavF32(
        resolve(import.meta.dirname, `../../test-utils/golden/passthrough/default__${sig}.wav`),
      );
      const db = rmsDiffDbFs([new Float32Array(result)], [golden.samples[0]!]);
      expect(db).toBeLessThan(-96);
    });
  }
});
