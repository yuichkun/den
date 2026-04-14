import "./styles.css";

import * as gain from "./pages/gain.js";
import * as passthrough from "./pages/passthrough.js";

interface Page {
  name: string;
  /**
   * `signal` aborts when the user navigates away. Pages MUST:
   *  - check `signal.aborted` before any `window.__denTier3a` /
   *    `window.__denReady` mutation that follows an `await`, and
   *  - register `signal.addEventListener("abort", () => …)` to tear
   *    down their AudioContext / source / RAF loop.
   * Without this, an in-flight `await` from the previous page can
   * resume after the new page mounts and clobber the bridge with
   * stale effect symbols (and leave the previous page's audio
   * playing in the background).
   */
  render: (root: HTMLElement, signal: AbortSignal) => void | Promise<void>;
}

// Sidebar order is the iteration order of this object.
const PAGES: Record<string, Page> = {
  passthrough,
  gain,
  // SCAFFOLDER:INSERT_PAGE
};

let currentRender: AbortController | null = null;

function render(): void {
  // Abort the previous page's render — fires its `signal.abort` event
  // so its teardown handlers run (close AudioContext, cancel RAF,
  // etc.) and any awaited bridge writes bail out before mutating
  // `window.__denTier3a`.
  currentRender?.abort();
  currentRender = new AbortController();
  const signal = currentRender.signal;

  const hash = location.hash.slice(2) || "passthrough";
  const page = PAGES[hash];
  const stage = document.getElementById("stage")!;
  stage.innerHTML = "";
  // Reset the Tier3a bridge before the new page mounts. Without this,
  // navigating /#/passthrough → /#/gain would briefly surface stale
  // `Passthrough` references via `__denTier3a` (each page sets
  // `__denReady` true at the END of its render).
  window.__denReady = false;
  delete window.__denTier3a;
  if (!page) {
    stage.textContent = `Unknown effect: ${hash}`;
    return;
  }
  void page.render(stage, signal);
}

function renderSidebar(): void {
  const sidebar = document.getElementById("sidebar")!;
  sidebar.innerHTML = `<nav><h1>den</h1><ul>${Object.entries(PAGES)
    .map(([slug, p]) => `<li><a href="#/${slug}">${p.name}</a></li>`)
    .join("")}</ul></nav>`;
}

renderSidebar();
render();
window.addEventListener("hashchange", render);
