import { Gain } from "@denaudio/effects";
import { CANONICAL } from "@denaudio/test-utils/signals";
import workletUrl from "../../../worklet/dist/processor.js?url";

import "../test-bridge.js";
import { renderEffectPage } from "../lib/effect-page.js";

export const name = "Gain";

/**
 * Gain catalog page. Declarative — all lifecycle, UI scaffolding,
 * source picking, transport, Bypass, AbortSignal teardown, file
 * upload, and AnalyserNode + rAF visualization live in
 * `lib/effect-page.ts` so future effects can share the patterns
 * (Sub D's explicit purpose: establish the canonical effect shape
 * that Sub E's add-effect template will reference).
 */
export async function render(root: HTMLElement, signal: AbortSignal): Promise<void> {
  await renderEffectPage(root, signal, {
    title: "Gain",
    description: "Linear per-channel multiplier with 20 ms 1-pole smoothing.",
    register: (ctx, opts) => Gain.register(ctx, opts),
    makeNode: (ctx, params) =>
      new Gain(ctx, params.gain !== undefined ? { gain: params.gain } : {}),
    applyParam: (node, name, value, ctx) => {
      if (name === "gain") {
        node.gain.setValueAtTime(value, ctx.currentTime);
      }
    },
    params: [{ name: "gain", min: 0, max: 2, step: 0.01, initial: 1 }],
    bridge: ({ workletUrl }) => {
      window.__denTier3a = { ...window.__denTier3a, Gain, CANONICAL, workletUrl };
    },
    workletUrl,
  });
}
