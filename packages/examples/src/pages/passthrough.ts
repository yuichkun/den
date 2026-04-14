import { Passthrough } from "@denaudio/effects";
import { CANONICAL } from "@denaudio/test-utils/signals";
import workletUrl from "../../../worklet/dist/processor.js?url";

import "../test-bridge.js";
import { renderEffectPage } from "../lib/effect-page.js";

export const name = "Passthrough";

/**
 * Passthrough catalog page. Declarative — see `pages/gain.ts` for
 * the full helper shape. No `params` block (Passthrough has no
 * AudioParams); Bypass toggle is still mounted by the helper so
 * reviewers can confirm output IS bit-identical to input either
 * way (a useful pipeline-sanity check).
 */
export async function render(root: HTMLElement, signal: AbortSignal): Promise<void> {
  await renderEffectPage(root, signal, {
    title: "Passthrough (Sub B stub)",
    description: "Identity: output equals input. Used to validate the pipeline end-to-end.",
    register: (ctx, opts) => Passthrough.register(ctx, opts),
    makeNode: (ctx) => new Passthrough(ctx),
    bridge: ({ workletUrl }) => {
      window.__denTier3a = { ...window.__denTier3a, Passthrough, CANONICAL, workletUrl };
    },
    workletUrl,
  });
}
