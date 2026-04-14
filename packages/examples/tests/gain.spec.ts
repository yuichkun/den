/// <reference types="node" />
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import "../src/test-bridge.js";

// Per Issue #5 §7.3 minimum: 4 (preset, signal) pairs covering unity,
// minus_6db, silence, mid_fade against the chirp signal. plus_6db is
// excluded from the chirp set because it hits the f32-vs-f64
// transient noise floor (Tier2 §8 Fallback #2 (b)) — its other
// preset/signal combinations are still covered by Tier2.
const PAIRS: Array<{ preset: string; signal: string }> = [
  { preset: "unity", signal: "chirp" },
  { preset: "minus_6db", signal: "chirp" },
  { preset: "silence", signal: "chirp" },
  { preset: "mid_fade", signal: "chirp" },
];

const PRESET_TO_GAIN: Record<string, number> = {
  unity: 1.0,
  minus_6db: 0.5011872336272722,
  plus_6db: 1.9952623149688795,
  silence: 0.0,
  mid_fade: 0.25,
};

test.describe("Tier3a: Gain through AudioWorklet", () => {
  for (const { preset, signal } of PAIRS) {
    test(`null test against golden (${preset}/${signal})`, async ({ page }) => {
      page.on("pageerror", (err) => console.log("pageerror:", err.message));
      await page.goto("/#/gain");
      await page.waitForFunction(() => Boolean(window.__denReady));

      const targetGain = PRESET_TO_GAIN[preset]!;
      const result = await page.evaluate(
        async ({ signalName, target }) => {
          const api = window.__denTier3a;
          if (!api?.Gain) {
            throw new Error("__denTier3a.Gain missing — page not ready");
          }
          const { Gain, CANONICAL, workletUrl } = api;
          const factory = CANONICAL[signalName];
          if (!factory) throw new Error(`unknown signal: ${signalName}`);
          const inSig = factory();
          const ctx = new OfflineAudioContext({
            numberOfChannels: 2,
            length: inSig.length,
            sampleRate: 48000,
          });
          await Gain.register(ctx, { workletUrl });
          // Construct the node WITHOUT `parameterData.gain` so the
          // initial value comes from the descriptor (1.0). Then drive
          // the target via `setValueAtTime(target, 0)` — exercises the
          // AudioParam pathway (a-rate scheduling), not just the
          // constructor's initial. Matches the issue §6.7 directive.
          const node = new Gain(ctx);
          node.gain.setValueAtTime(target, 0);
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
        },
        { signalName: signal, target: targetGain },
      );

      expect(result[0]!.length).toBeGreaterThan(0);
      expect(result[1]!.length).toBeGreaterThan(0);
      const { readWavF32, rmsDiffDbFs } = await import("@denaudio/test-utils/node");
      const golden = readWavF32(
        resolve(import.meta.dirname, `../../test-utils/golden/gain/${preset}__${signal}.wav`),
      );
      const db = rmsDiffDbFs(
        [new Float32Array(result[0]!), new Float32Array(result[1]!)],
        [golden.samples[0]!, golden.samples[1]!],
      );
      // -96 dBFS for the four tight presets selected here. plus_6db is
      // intentionally absent from this Tier3a set; Tier2 covers it at
      // -90 dBFS per the documented Fallback.
      expect(db).toBeLessThan(-96);
    });
  }
});
