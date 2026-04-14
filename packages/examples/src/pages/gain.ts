import { Gain } from "@denaudio/effects";
import { CANONICAL } from "@denaudio/test-utils/signals";
import workletUrl from "../../../worklet/dist/processor.js?url";

import "../test-bridge.js";
import { mountEffectPage } from "../effect-page.js";

export const name = "Gain";

export async function render(root: HTMLElement): Promise<void> {
  await mountEffectPage(root, {
    title: "Gain",
    description: "Linear per-channel multiplier with 20 ms 1-pole smoothing. Initial = 1.0.",
    register: (ctx, opts) => Gain.register(ctx, opts),
    // `params.gain` is the live value of the slider (defaults to the
    // ParamSpec's `initial`). Each fresh node starts at the current
    // slider value so re-enabling A/B keeps the user's edit.
    // Conditional spread because `noUncheckedIndexedAccess` widens the
    // dictionary lookup to `number | undefined`, and `exactOptional-
    // PropertyTypes` rejects an explicit `undefined` for an optional.
    makeNode: (ctx, params) =>
      new Gain(ctx, params.gain !== undefined ? { gain: params.gain } : {}),
    applyParam: (node, name, value, ctx) => {
      if (name === "gain") {
        node.gain.setValueAtTime(value, ctx.currentTime);
      }
    },
    params: [{ name: "gain", min: 0, max: 2, step: 0.01, initial: 1 }],
    workletUrl,
    bridge: ({ workletUrl }) => {
      window.__denTier3a = {
        ...window.__denTier3a,
        Gain,
        CANONICAL,
        workletUrl,
      };
      window.__denReady = true;
    },
  });
}
