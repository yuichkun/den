import { Passthrough } from "@denaudio/effects";
import { CANONICAL } from "@denaudio/test-utils/signals";
// Vite's `?url` only accepts local paths, not bare package specifiers with a
// query suffix. Point at the built worklet IIFE via a workspace-relative
// path so the dev server can serve it as-is. We pass this to
// `Passthrough.register` as `workletUrl` because the default
// `new URL("./processor.js", import.meta.url)` inside worklet/main.js
// gets rewritten by Vite into an inlined data: URL of the TS source
// (issue #3 §8 Fallback #2 — deferred to Sub C).
import workletUrl from "../../../worklet/dist/processor.js?url";

import "../test-bridge.js";
import { mountEffectPage } from "../effect-page.js";

export const name = "Passthrough";

export async function render(root: HTMLElement): Promise<void> {
  await mountEffectPage(root, {
    title: "Passthrough (Sub B stub)",
    description: "Identity: output == input. Used to validate the pipeline end-to-end.",
    register: (ctx, opts) => Passthrough.register(ctx, opts),
    makeNode: (ctx) => new Passthrough(ctx),
    workletUrl,
    bridge: ({ workletUrl }) => {
      window.__denTier3a = {
        ...window.__denTier3a,
        Passthrough,
        CANONICAL,
        workletUrl,
      };
      window.__denReady = true;
    },
  });
}
