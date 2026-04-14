// Shared `window.__denTier3a` global augmentation for the Tier3a
// page<->Playwright bridge. Imported for side effects from both the
// Passthrough page (`pages/passthrough.ts`) and the spec file
// (`tests/passthrough.spec.ts`) so the typing stays aligned. No runtime
// code — just a module-level `export {}` to keep TS treating this as a
// module rather than a script.
import type { Passthrough } from "@denaudio/effects";
import type { CANONICAL } from "@denaudio/test-utils/signals";

declare global {
  interface Window {
    __denTier3a?: {
      Passthrough: typeof Passthrough;
      CANONICAL: typeof CANONICAL;
      workletUrl: string;
    };
    __denReady?: boolean;
  }
}

export {};
