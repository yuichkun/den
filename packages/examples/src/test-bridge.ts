// Shared `window.__denTier3a` global augmentation for the Tier3a
// page<->Playwright bridge. Imported for side effects from every
// `pages/<effect>.ts` and from the matching `tests/<effect>.spec.ts`
// so the typing stays aligned. No runtime code — just a module-level
// `export {}` to keep TS treating this as a module rather than a
// script.
//
// All effect-class fields are optional because navigation between
// pages overwrites the bridge with the latest page's effect; the
// individual specs guard with `if (!api.Gain) throw ...` style
// checks, so the union of pages doesn't have to fit in one shape.
import type { Gain, Passthrough } from "@denaudio/effects";
import type { CANONICAL } from "@denaudio/test-utils/signals";

declare global {
  interface Window {
    __denTier3a?: {
      Passthrough?: typeof Passthrough;
      Gain?: typeof Gain;
      CANONICAL: typeof CANONICAL;
      workletUrl: string;
    };
    __denReady?: boolean;
  }
}

export {};
