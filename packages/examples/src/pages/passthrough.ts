import { Passthrough } from "@denaudio/effects";
import { CANONICAL } from "@denaudio/test-utils/signals";
// Vite's `?url` only accepts local paths, not bare package specifiers with a
// query suffix. Point at the built worklet IIFE via a workspace-relative
// path so the dev server can serve it as-is. We pass this to
// `Passthrough.register/create` as `workletUrl` because the default
// `new URL("./processor.js", import.meta.url)` inside worklet/main.js
// gets rewritten by Vite into an inlined data: URL of the TS source
// (issue #3 §8 Fallback #2 — deferred to Sub C).
import workletUrl from "../../../worklet/dist/processor.js?url";

import "../test-bridge.js";

import { mountABPlayer, mountSpectrogram, mountWaveform } from "../widgets.js";

export const name = "Passthrough";

export async function render(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <h2>Passthrough (Sub B stub)</h2>
    <p>Identity: output == input. Used to validate the pipeline end-to-end.</p>
    <section id="status">loading…</section>
    <section id="ab"></section>
    <p style="opacity:0.6;font-size:0.85em;margin:0.5rem 0;">
      The Wet/Dry slider above only affects realtime playback. The
      visualizers below always show the effect output (wet) — they
      auto-refresh when you change the signal selector.
    </p>
    <section id="wave"></section>
    <section id="spec"></section>
  `;

  const status = document.getElementById("status")!;

  // Eagerly prove the pipeline works on an OfflineAudioContext. This
  // does not need a user gesture, so it runs in headless Chromium
  // (Playwright) without extra flags. Once __denReady is set, Tier3a
  // drives its own fresh OAC inside page.evaluate.
  try {
    const probeCtx = new OfflineAudioContext({
      numberOfChannels: 2,
      length: 128,
      sampleRate: 48000,
    });
    await Passthrough.register(probeCtx, { workletUrl });
    status.textContent = "pipeline ready ✓";
  } catch (err) {
    status.textContent = "pipeline failed — see console";
    throw err;
  }

  // A/B player needs a realtime AudioContext, which Chromium refuses to
  // start without a user gesture. Defer construction until the user
  // clicks "Enable A/B player" (a gesture), so the catalog page loads
  // cleanly even without audio permissions.
  const abContainer = document.getElementById("ab")!;
  abContainer.innerHTML = `<button class="enable">Enable A/B player</button>`;
  const enableBtn = abContainer.querySelector<HTMLButtonElement>(".enable")!;
  enableBtn.addEventListener("click", () => {
    void (async () => {
      const ctx = new AudioContext();
      if (ctx.state === "suspended") await ctx.resume();
      await Passthrough.register(ctx, { workletUrl });
      abContainer.innerHTML = "";
      // Forward-declare so we can pass refreshViz to the player as
      // its onSignalChange handler before defining it below.
      let refreshViz: () => Promise<void>;
      const player = mountABPlayer(
        abContainer,
        ctx,
        async (c) => Passthrough.create(c, { workletUrl }),
        () => refreshViz(),
      );
      refreshViz = async () => {
        const buf = await player.getLastRendered();
        mountWaveform(document.getElementById("wave")!, buf);
        mountSpectrogram(document.getElementById("spec")!, buf);
      };
      await refreshViz();
    })();
  });

  window.__denTier3a = { Passthrough, CANONICAL, workletUrl };
  window.__denReady = true;
}
