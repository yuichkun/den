import "./styles.css";

import * as gain from "./pages/gain.js";
import * as passthrough from "./pages/passthrough.js";

interface Page {
  name: string;
  render: (root: HTMLElement) => void | Promise<void>;
}

// Sidebar order is the iteration order of this object.
const PAGES: Record<string, Page> = { passthrough, gain };

function render(): void {
  const hash = location.hash.slice(2) || "passthrough";
  const page = PAGES[hash];
  const stage = document.getElementById("stage")!;
  stage.innerHTML = "";
  // Reset the Tier3a bridge before the new page mounts. Without this,
  // navigating /#/passthrough → /#/gain → /#/passthrough would briefly
  // surface stale `Gain` references via `__denTier3a` (each page sets
  // `__denReady` true at the END of its render, but `__denTier3a` is
  // mutated incrementally via spread). Resetting up front means the
  // Playwright spec only sees a fresh bridge populated by the
  // currently-mounting page.
  window.__denReady = false;
  delete window.__denTier3a;
  if (!page) {
    stage.textContent = `Unknown effect: ${hash}`;
    return;
  }
  void page.render(stage);
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
