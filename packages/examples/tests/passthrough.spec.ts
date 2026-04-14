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
      // Render and return BOTH stereo channels so the null test
      // exercises L and R independently (Tier2 does the same via the
      // runner's `golden.samples` pair). Returning only ch 0 would let
      // a future stereo-asymmetric regression in the worklet path
      // slip through CI — flagged by codex review on PR #12.
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
        return [Array.from(rendered.getChannelData(0)), Array.from(rendered.getChannelData(1))];
      }, sig);

      expect(result[0]!.length).toBeGreaterThan(0);
      expect(result[1]!.length).toBeGreaterThan(0);
      const { readWavF32, rmsDiffDbFs } = await import("@denaudio/test-utils/node");
      const golden = readWavF32(
        resolve(import.meta.dirname, `../../test-utils/golden/passthrough/default__${sig}.wav`),
      );
      const db = rmsDiffDbFs(
        [new Float32Array(result[0]!), new Float32Array(result[1]!)],
        [golden.samples[0]!, golden.samples[1]!],
      );
      expect(db).toBeLessThan(-96);
    });
  }
});
