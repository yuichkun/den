import "./styles.css";

import * as passthrough from "./pages/passthrough.js";

interface Page {
  name: string;
  render: (root: HTMLElement) => void | Promise<void>;
}

const PAGES: Record<string, Page> = { passthrough };

function render(): void {
  const hash = location.hash.slice(2) || "passthrough";
  const page = PAGES[hash];
  const stage = document.getElementById("stage")!;
  stage.innerHTML = "";
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
