import "./style.css";
import {
  modules,
  History,
  newNode,
  presets,
  parsePatch,
  validate,
  dspKey,
  parameters,
  type Kind,
  type Patch,
  type Edge,
  type Port,
} from "./graph.ts";
import { AudioEngine } from "./audio.ts";
import build from "virtual:den-kit-build";
const el = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const symbols: Record<Kind, string> = {
  note: "♩",
  oscillator: "∿",
  filter: "⌁",
  envelope: "⌁",
  lfo: "∿",
  vca: "×",
  mixer: "+",
  delay: "⋮",
  output: "◖",
};
const colors = { audio: "#dc7768", cv: "#66bcb5", gate: "#d9b64e", pitch: "#e6a65e" };
const history = new History(presets()[0]!);
let selected = "filter",
  selectedEdge = "",
  zoom = 0.85,
  serial = 100,
  pending: {
    node: string;
    port: string;
    side: "in" | "out";
  } | null = null;
let pointer = { x: 0, y: 0 };
const held = new Map<string, number>();
let toastTimer: ReturnType<typeof setTimeout>;
const engine = new AudioEngine(() => updateStatus());
el("#app").innerHTML = `
<header class="app-header"><div class="brand"><span class="brand-mark"><i></i><i></i><i></i><i></i></span><strong>den-kit</strong><span class="tag">PROTOTYPE</span></div><div class="transport"><span id="audio-light"></span><span id="audio-status">Audio stopped</span><button id="apply" class="primary">▶ Apply & play</button><button id="stop">■ Stop</button><button id="panic" title="Immediately mute and reset every DSP module">Panic</button></div><a class="source-link" target="_blank" rel="noopener" href="https://github.com/yuichkun/den">den / unworklet ↗</a></header>
<section class="palette"><div class="palette-search"><label for="search">MODULES</label><input id="search" type="search" placeholder="Find a module…" autocomplete="off"><span>Drag or click to add</span></div><div id="module-list"></div></section>
<nav class="patch-bar"><div class="patch-title"><span class="mini-label">PATCH</span><select id="preset" aria-label="Starting patch"><option value="0">Amber keys</option><option value="1">Slow orbit</option><option value="2">Empty patch</option></select><span id="dirty">Not applied</span></div><div class="patch-actions"><button id="undo" title="Undo (Ctrl/Cmd Z)">↶</button><button id="redo" title="Redo (Ctrl/Cmd Shift Z)">↷</button><span class="separator"></span><button id="import">Import</button><button id="export">Export</button><input id="file" type="file" accept=".json,application/json" hidden><span class="separator"></span><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-reset">85%</button><button id="zoom-in" aria-label="Zoom in">+</button></div></nav>
<main><aside class="inspector"><div id="inspector-content"></div><section class="scope"><div class="section-label">OUTPUT <span id="level">−∞ dB</span></div><canvas id="scope" width="400" height="150"></canvas><div class="master-label"><label for="volume">Listening level</label><span id="volume-value">25%</span></div><input id="volume" type="range" min="0" max="0.5" step=".01" value=".25"><p>48 kHz · stereo · candidate audio</p></section><div class="prototype-note"><b>A patching sketch.</b><p>Real den DSP. A small, editable starting point for the musician-facing experience.</p><p>Topology changes restart audio on Apply. AI, UI design and Portal integration are future work.</p></div></aside><section id="viewport" aria-label="Patch canvas"><div id="world"><div id="board"><svg id="cables" aria-label="Patch cables"></svg><div id="nodes"></div></div></div><div id="canvas-help">Connect matching ports · Drag headers to move · Delete to remove</div><div id="toast" role="status" aria-live="polite"></div></section></main>
<footer class="performance"><div class="keyboard-label"><span class="section-label">PLAY</span><strong>Try your patch</strong><small>A W S E D F T G Y H U J K</small></div><div id="keyboard" aria-label="One octave musical keyboard"></div><div class="performance-notes"><span id="note-status">No keys held</span><small>Click Apply, then play.<br>Slow orbit plays as a drone.</small></div><div class="patch-summary"><span id="counts"></span><small>Manual patching · Draft only</small></div></footer>`;
function message(text: string) {
  el("#toast").textContent = text;
  el("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el("#toast").classList.remove("visible"), 5000);
}
function updateStatus() {
  if (!document.querySelector("#audio-status")) return;
  const dirty = engine.appliedKey !== dspKey(history.patch);
  el("#audio-status").textContent =
    engine.phase === "compiling"
      ? "Compiling patch…"
      : engine.phase === "playing"
        ? engine.state().panicked
          ? "Muted by Panic"
          : "Audio running"
        : engine.phase === "error"
          ? "Could not start"
          : "Audio stopped";
  el("#audio-light").className = engine.phase;
  el<HTMLButtonElement>("#stop").disabled = engine.phase === "idle";
  el<HTMLButtonElement>("#panic").disabled = engine.phase !== "playing";
  el("#apply").textContent =
    engine.phase === "compiling"
      ? "↻ Restart apply"
      : engine.phase === "playing"
        ? dirty
          ? "▶ Apply changes"
          : "↻ Restart patch"
        : "▶ Apply & play";
  el("#dirty").textContent =
    engine.phase === "compiling" ? "Compiling" : dirty ? "Changes need Apply" : "Applied";
  el("#dirty").classList.toggle("is-dirty", dirty);
  el<HTMLButtonElement>("#undo").disabled = !history.canUndo;
  el<HTMLButtonElement>("#redo").disabled = !history.canRedo;
  el("#counts").textContent =
    `${history.patch.nodes.length} modules / ${history.patch.edges.length} cables`;
  if (engine.error) message(engine.error);
}
function edit(change: (p: Patch) => void, redraw = true) {
  try {
    const next = structuredClone(history.patch);
    change(next);
    const changedSound =
      dspKey(next) !== dspKey(history.patch) ||
      JSON.stringify(parameters(next)) !== JSON.stringify(parameters(history.patch));
    history.commit(next);
    if (changedSound && engine.phase === "compiling") void engine.stop();
    engine.updateParameters(history.patch);
    if (redraw) render();
    else updateStatus();
  } catch (e) {
    message(e instanceof Error ? e.message : String(e));
  }
}
function portMarkup(n: string, p: Port, side: "in" | "out") {
  return `<button class="port ${side}" style="--signal:${colors[p.domain]}" data-node="${n}" data-port="${p.id}" data-side="${side}" aria-label="${side === "in" ? "Input" : "Output"} ${n} ${p.label}" title="${escape(p.description)}"><i></i><span>${escape(p.label)}${p.channels === 2 ? " L/R" : ""}</span></button>`;
}
function render() {
  el("#nodes").innerHTML = history.patch.nodes
    .map((n) => {
      const m = modules[n.kind];
      return `<article class="module ${selected === n.id ? "selected" : ""}" data-id="${n.id}" style="left:${n.x}px;top:${n.y}px;--module:${m.color}" tabindex="0" aria-label="${m.title} module ${n.id}"><div class="module-header"><span class="module-symbol">${symbols[n.kind]}</span><b>${m.title}</b><button class="remove" aria-label="Remove ${n.id}">×</button></div>${m.modes ? `<select class="mode" data-node="${n.id}" aria-label="${n.id} mode">${m.modes.map((mode) => `<option ${mode === n.mode ? "selected" : ""}>${mode}</option>`).join("")}</select>` : ""}<div class="ports"><div>${m.inputs.map((p) => portMarkup(n.id, p, "in")).join("")}</div><div>${m.outputs.map((p) => portMarkup(n.id, p, "out")).join("")}</div></div>${Object.entries(
        m.controls,
      )
        .map(
          ([key, c]) =>
            `<div class="control"><div><label for="${n.id}-${key}">${c.label}</label><input class="number" id="${n.id}-${key}" data-node="${n.id}" data-key="${key}" type="number" min="${c.min}" max="${c.max}" step="any" value="${n.params[key]}" aria-label="${n.id} ${c.label}"><small>${c.unit}</small></div><input class="slider" data-node="${n.id}" data-key="${key}" type="range" min="0" max="1000" step="1" value="${toSlider(n.params[key]!, c.min, c.max, !!c.log)}" aria-label="${n.id} ${c.label} slider"></div>`,
        )
        .join(
          "",
        )}<div class="module-foot">${escape(n.id)}${n.kind === "note" ? " · mono" : n.kind === "output" ? " · stereo" : ""}</div></article>`;
    })
    .join("");
  el("#nodes")
    .querySelectorAll<HTMLElement>(".module")
    .forEach((card) => {
      const id = card.dataset.id!;
      card.addEventListener("pointerdown", () => select(id));
      card.addEventListener("focus", () => select(id));
      card.querySelector(".remove")!.addEventListener("click", () => removeNode(id));
      const header = card.querySelector<HTMLElement>(".module-header")!;
      header.onpointerdown = (e) => {
        if ((e.target as Element).closest("button")) return;
        e.preventDefault();
        select(id);
        const n = history.patch.nodes.find((n) => n.id === id)!,
          start = { x: e.clientX, y: e.clientY },
          base = { x: n.x, y: n.y };
        let x = n.x,
          y = n.y;
        header.setPointerCapture(e.pointerId);
        header.onpointermove = (move) => {
          x = Math.max(
            0,
            Math.min(1400, Math.round((base.x + (move.clientX - start.x) / zoom) / 8) * 8),
          );
          y = Math.max(
            0,
            Math.min(740, Math.round((base.y + (move.clientY - start.y) / zoom) / 8) * 8),
          );
          card.style.left = x + "px";
          card.style.top = y + "px";
          drawCables();
        };
        const finish = () => {
          header.onpointermove = null;
          header.onpointerup = null;
          header.onpointercancel = null;
          edit((p) => {
            const n = p.nodes.find((n) => n.id === id)!;
            n.x = x;
            n.y = y;
          });
        };
        header.onpointerup = finish;
        header.onpointercancel = () => {
          header.onpointermove = null;
          render();
        };
      };
    });
  el("#nodes")
    .querySelectorAll<HTMLSelectElement>(".mode")
    .forEach(
      (input) =>
        (input.onchange = () =>
          edit((p) => (p.nodes.find((n) => n.id === input.dataset.node)!.mode = input.value))),
    );
  el("#nodes")
    .querySelectorAll<HTMLInputElement>(".number")
    .forEach(
      (input) =>
        (input.onchange = () => {
          const id = input.dataset.node!,
            key = input.dataset.key!,
            n = history.patch.nodes.find((n) => n.id === id)!;
          const c = modules[n.kind].controls[key]!;
          const value = input.valueAsNumber;
          if (!Number.isFinite(value) || value < c.min || value > c.max) {
            message(`${c.label}: enter ${c.min}–${c.max} ${c.unit}.`);
            input.value = String(n.params[key]);
            return;
          }
          edit((p) => (p.nodes.find((n) => n.id === id)!.params[key] = value));
        }),
    );
  el("#nodes")
    .querySelectorAll<HTMLInputElement>(".slider")
    .forEach((input) => {
      const id = input.dataset.node!,
        key = input.dataset.key!,
        n = history.patch.nodes.find((n) => n.id === id)!,
        c = modules[n.kind].controls[key]!;
      const value = () => {
        const t = Number(input.value) / 1000;
        return c.log ? c.min * (c.max / c.min) ** t : c.min + (c.max - c.min) * t;
      };
      input.oninput = () => {
        const next = structuredClone(history.patch);
        next.nodes.find((n) => n.id === id)!.params[key] = value();
        engine.updateParameters(next);
        el<HTMLInputElement>(`#${id}-${key}`).value = String(Number(value().toPrecision(5)));
      };
      input.onchange = () =>
        edit(
          (p) => (p.nodes.find((n) => n.id === id)!.params[key] = Number(value().toPrecision(6))),
        );
    });
  el("#nodes")
    .querySelectorAll<HTMLButtonElement>(".port")
    .forEach((port) => {
      port.onpointerdown = (e) => {
        e.stopPropagation();
        e.preventDefault();
        pickPort(port);
      };
      port.onclick = (e) => {
        if (e.detail === 0) pickPort(port);
      };
    });
  renderInspector();
  updateStatus();
  requestAnimationFrame(drawCables);
}
function toSlider(v: number, min: number, max: number, log: boolean) {
  return Math.round(
    (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min)) * 1000,
  );
}
function select(id: string) {
  selected = id;
  selectedEdge = "";
  el("#nodes")
    .querySelectorAll<HTMLElement>(".module")
    .forEach((n) => n.classList.toggle("selected", n.dataset.id === id));
  renderInspector();
  drawCables();
}
function removeNode(id: string) {
  edit((p) => {
    p.nodes = p.nodes.filter((n) => n.id !== id);
    p.edges = p.edges.filter((e) => e.from.node !== id && e.to.node !== id);
  });
  if (selected === id) {
    selected = "";
    renderInspector();
  }
}
function renderInspector() {
  const n = history.patch.nodes.find((n) => n.id === selected);
  if (!n) {
    el("#inspector-content").innerHTML =
      `<div class="section-label">INSPECTOR</div><h2>Your patch</h2><p>Select a module to see its signal types and controls.</p><p>Start with a preset, or add modules from the palette.</p>`;
    return;
  }
  const m = modules[n.kind];
  el("#inspector-content").innerHTML =
    `<div class="section-label">${m.category.toUpperCase()}</div><div class="inspector-title" style="color:${m.color}">${symbols[n.kind]} <h2>${m.title}</h2></div><p>${m.description}</p><dl>${[...m.inputs, ...m.outputs].map((p) => `<dt><i style="background:${colors[p.domain]}"></i>${p.label}</dt><dd>${p.description}</dd>`).join("")}</dl><button id="delete-module" class="subtle">Remove module</button>`;
  el("#delete-module").onclick = () => removeNode(n.id);
}
function endpoint(n: string, p: string, side: string) {
  const target = document.querySelector<HTMLElement>(
    `.port[data-node="${n}"][data-port="${p}"][data-side="${side}"] i`,
  );
  if (!target) return null;
  const r = target.getBoundingClientRect(),
    b = el("#board").getBoundingClientRect();
  return { x: (r.left + r.width / 2 - b.left) / zoom, y: (r.top + r.height / 2 - b.top) / zoom };
}
function curve(
  a: {
    x: number;
    y: number;
  },
  b: {
    x: number;
    y: number;
  },
) {
  const bend = Math.max(55, Math.abs(b.x - a.x) * 0.45);
  return `M${a.x},${a.y} C${a.x + bend},${a.y} ${b.x - bend},${b.y} ${b.x},${b.y}`;
}
function drawCables() {
  const svg = document.querySelector<SVGSVGElement>("#cables")!;
  svg.innerHTML = history.patch.edges
    .map((e) => {
      const a = endpoint(e.from.node, e.from.port, "out"),
        b = endpoint(e.to.node, e.to.port, "in");
      if (!a || !b) return "";
      const n = history.patch.nodes.find((n) => n.id === e.from.node)!;
      const port = modules[n.kind].outputs.find((p) => p.id === e.from.port)!;
      return `<g class="cable ${selectedEdge === e.id ? "selected" : ""}" data-edge="${e.id}" tabindex="0" role="button" aria-label="Cable ${e.from.node} ${e.from.port} to ${e.to.node} ${e.to.port}"><path class="cable-hit" d="${curve(a, b)}"/><path d="${curve(a, b)}" style="stroke:${colors[port.domain]}"/></g>`;
    })
    .join("");
  if (pending) {
    const a = endpoint(pending.node, pending.port, pending.side);
    if (a)
      svg.innerHTML += `<path class="pending" d="${pending.side === "out" ? curve(a, pointer) : curve(pointer, a)}"/>`;
  }
  svg.querySelectorAll<SVGGElement>(".cable").forEach((g) => {
    g.onclick = (e) => {
      e.stopPropagation();
      selectedEdge = g.dataset.edge!;
      drawCables();
      message("Cable selected. Press Delete to remove it.");
    };
    g.onfocus = () => {
      selectedEdge = g.dataset.edge!;
      svg.querySelectorAll(".cable").forEach((c) => c.classList.toggle("selected", c === g));
    };
    g.onkeydown = (e) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        const id = g.dataset.edge!;
        selectedEdge = "";
        edit((p) => (p.edges = p.edges.filter((edge) => edge.id !== id)));
      }
    };
  });
}
function pickPort(button: HTMLElement) {
  const next = {
    node: button.dataset.node!,
    port: button.dataset.port!,
    side: button.dataset.side as "in" | "out",
  };
  if (!pending) {
    pending = next;
    const at = endpoint(next.node, next.port, next.side);
    if (at) pointer = at;
    message("Choose a matching port. Escape cancels.");
    drawCables();
    return;
  }
  if (pending.node === next.node && pending.port === next.port && pending.side === next.side) {
    pending = null;
    drawCables();
    return;
  }
  connect(next);
}
function connect(next: { node: string; port: string; side: "in" | "out" }) {
  if (!pending) return;
  if (pending.side === next.side) {
    message("Connect an output to an input.");
    return;
  }
  const from = pending.side === "out" ? pending : next,
    to = pending.side === "in" ? pending : next;
  pending = null;
  edit((p) =>
    p.edges.push({
      id: nextId("c"),
      from: { node: from.node, port: from.port },
      to: { node: to.node, port: to.port },
    }),
  );
  drawCables();
}
document.addEventListener("pointermove", (e) => {
  if (!pending) return;
  const r = el("#board").getBoundingClientRect();
  pointer = { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  drawCables();
});
document.addEventListener("pointerup", (e) => {
  if (!pending) return;
  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".port");
  if (
    target &&
    (target.dataset.node !== pending.node ||
      target.dataset.port !== pending.port ||
      target.dataset.side !== pending.side)
  )
    connect({
      node: target.dataset.node!,
      port: target.dataset.port!,
      side: target.dataset.side as "in" | "out",
    });
});
function nextId(prefix: string) {
  let id: string;
  do {
    id = `${prefix}${++serial}`;
  } while (
    history.patch.nodes.some((n) => n.id === id) ||
    history.patch.edges.some((e) => e.id === id)
  );
  return id;
}
function add(kind: Kind, x?: number, y?: number) {
  const view = el("#viewport");
  edit((p) =>
    p.nodes.push(
      newNode(
        kind,
        nextId("n"),
        x ?? Math.min(1300, Math.round((view.scrollLeft / zoom + 80) / 8) * 8),
        y ?? Math.min(650, Math.round((view.scrollTop / zoom + 80) / 8) * 8),
      ),
    ),
  );
}
function palette() {
  const query = el<HTMLInputElement>("#search").value.toLowerCase();
  el("#module-list").innerHTML = (Object.keys(modules) as Kind[])
    .filter((k) => `${modules[k].title} ${modules[k].category}`.toLowerCase().includes(query))
    .map(
      (k) =>
        `<button draggable="true" class="palette-module" data-kind="${k}" style="--module:${modules[k].color}"><span>${symbols[k]}</span><b>${modules[k].title}</b><small>${modules[k].category}</small></button>`,
    )
    .join("");
  el("#module-list")
    .querySelectorAll<HTMLButtonElement>("button")
    .forEach((b) => {
      b.onclick = () => add(b.dataset.kind as Kind);
      b.ondragstart = (e) => e.dataTransfer?.setData("text/den-kit-module", b.dataset.kind!);
    });
}
el("#search").oninput = palette;
el("#viewport").ondragover = (e) => {
  if (e.dataTransfer?.types.includes("text/den-kit-module")) e.preventDefault();
};
el("#viewport").ondrop = (e) => {
  const kind = e.dataTransfer?.getData("text/den-kit-module");
  if (!kind || !Object.hasOwn(modules, kind)) return;
  e.preventDefault();
  const r = el("#board").getBoundingClientRect();
  add(
    kind as Kind,
    Math.max(0, Math.min(1400, Math.round((e.clientX - r.left) / zoom / 8) * 8)),
    Math.max(0, Math.min(700, Math.round((e.clientY - r.top) / zoom / 8) * 8)),
  );
};
el("#viewport").addEventListener("pointerdown", (e) => {
  if (
    e.button !== 1 &&
    !(
      e.shiftKey &&
      (e.target === el("#board") || e.target === el("#world") || e.target === el("#viewport"))
    )
  )
    return;
  e.preventDefault();
  const v = el("#viewport"),
    x = e.clientX,
    y = e.clientY,
    left = v.scrollLeft,
    top = v.scrollTop;
  v.setPointerCapture(e.pointerId);
  v.onpointermove = (move) => {
    v.scrollLeft = left - (move.clientX - x);
    v.scrollTop = top - (move.clientY - y);
  };
  v.onpointerup = () => (v.onpointermove = null);
});
function setZoom(value: number) {
  zoom = Math.max(0.5, Math.min(1.25, value));
  el("#board").style.transform = `scale(${zoom})`;
  el("#world").style.width = 1600 * zoom + "px";
  el("#world").style.height = 1100 * zoom + "px";
  el("#zoom-reset").textContent = Math.round(zoom * 100) + "%";
  drawCables();
}
el("#zoom-in").onclick = () => setZoom(zoom + 0.1);
el("#zoom-out").onclick = () => setZoom(zoom - 0.1);
el("#zoom-reset").onclick = () => setZoom(0.85);
function afterHistory() {
  releaseKeys();
  if (engine.phase === "compiling") void engine.stop();
  engine.updateParameters(history.patch);
  render();
}
el("#undo").onclick = () => {
  history.undo();
  afterHistory();
};
el("#redo").onclick = () => {
  history.redo();
  afterHistory();
};
el("#apply").onclick = () => {
  releaseKeys();
  void engine.apply(history.patch);
};
el("#stop").onclick = () => {
  releaseKeys();
  void engine.stop();
};
el("#panic").onclick = () => {
  releaseKeys();
  engine.panic();
  message("Output muted and DSP reset. Play a note or Apply to resume.");
};
el<HTMLSelectElement>("#preset").onchange = () => {
  releaseKeys();
  void engine.stop();
  history.commit(
    presets()[Number(el<HTMLSelectElement>("#preset").value)] ?? {
      version: 1,
      name: "Empty patch",
      nodes: [],
      edges: [],
    },
  );
  pending = null;
  selected = "filter";
  render();
};
el<HTMLInputElement>("#volume").oninput = () => {
  const value = el<HTMLInputElement>("#volume").valueAsNumber;
  engine.setVolume(value);
  el("#volume-value").textContent = Math.round(value * 100) + "%";
};
el("#export").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(history.patch, null, 2) + "\n"], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "den-kit-patch.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
el("#import").onclick = () => el<HTMLInputElement>("#file").click();
el<HTMLInputElement>("#file").onchange = async () => {
  const file = el<HTMLInputElement>("#file").files?.[0];
  if (!file) return;
  try {
    if (file.size > 100000) throw new Error("Patch file is too large (100 KB maximum).");
    const patch = parsePatch(await file.text());
    releaseKeys();
    await engine.stop();
    history.commit(patch);
    pending = null;
    selected = "";
    render();
    message("Patch imported. Apply to hear it.");
  } catch (e) {
    message(e instanceof Error ? e.message : String(e));
  } finally {
    el<HTMLInputElement>("#file").value = "";
  }
};
const keyMap: Record<string, number> = {
  a: 48,
  w: 49,
  s: 50,
  e: 51,
  d: 52,
  f: 53,
  t: 54,
  g: 55,
  y: 56,
  h: 57,
  u: 58,
  j: 59,
  k: 60,
};
const names = ["C3", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B", "C4"];
el("#keyboard").innerHTML = Array.from(
  { length: 13 },
  (_, i) =>
    `<button class="key ${[1, 3, 6, 8, 10].includes(i) ? "black" : "white"}" data-note="${48 + i}" aria-label="Play ${names[i]}"><span>${names[i]}</span></button>`,
).join("");
function press(identity: string, note: number) {
  if (held.has(identity) || engine.phase !== "playing") return;
  held.set(identity, note);
  engine.note(note, true);
  drawKeys();
}
function release(identity: string) {
  const note = held.get(identity);
  if (note === undefined) return;
  held.delete(identity);
  engine.note(note, false);
  drawKeys();
}
function releaseKeys() {
  for (const id of [...held.keys()]) release(id);
}
function drawKeys() {
  el("#keyboard")
    .querySelectorAll<HTMLElement>("[data-note]")
    .forEach((k) =>
      k.classList.toggle("held", [...held.values()].includes(Number(k.dataset.note))),
    );
  el("#note-status").textContent = held.size
    ? `${held.size} key${held.size > 1 ? "s" : ""} held`
    : "No keys held";
}
el("#keyboard")
  .querySelectorAll<HTMLButtonElement>("button")
  .forEach((key) => {
    key.onpointerdown = (e) => {
      e.preventDefault();
      key.setPointerCapture(e.pointerId);
      press(`pointer${e.pointerId}`, Number(key.dataset.note));
    };
    key.onpointerup = (e) => release(`pointer${e.pointerId}`);
    key.onpointercancel = (e) => release(`pointer${e.pointerId}`);
    key.onlostpointercapture = (e) => release(`pointer${e.pointerId}`);
    key.onkeydown = (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        press(`button${key.dataset.note}`, Number(key.dataset.note));
      }
    };
    key.onkeyup = () => release(`button${key.dataset.note}`);
    key.onblur = () => release(`button${key.dataset.note}`);
  });
function deleteSelection() {
  if (selectedEdge) {
    const id = selectedEdge;
    selectedEdge = "";
    edit((p) => (p.edges = p.edges.filter((e) => e.id !== id)));
  } else if (selected) removeNode(selected);
}
document.addEventListener("keydown", (e) => {
  const typing = (e.target as Element).closest("input,select,textarea");
  if (e.key === "Escape") {
    pending = null;
    drawCables();
    releaseKeys();
    return;
  }
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? history.redo() : history.undo();
    afterHistory();
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    deleteSelection();
    return;
  }
  if (!e.ctrlKey && !e.metaKey && Object.hasOwn(keyMap, e.key.toLowerCase())) {
    e.preventDefault();
    press(`key${e.code}`, keyMap[e.key.toLowerCase()]!);
  }
});
document.addEventListener("keyup", (e) => release(`key${e.code}`));
window.addEventListener("blur", releaseKeys);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseKeys();
});
window.addEventListener("pagehide", () => {
  releaseKeys();
  void engine.stop();
});
window.addEventListener("resize", drawCables);
const canvas = el<HTMLCanvasElement>("#scope"),
  ctx = canvas.getContext("2d")!;
function meter() {
  const samples = engine.samples();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#414748";
  ctx.beginPath();
  ctx.moveTo(0, 75);
  ctx.lineTo(400, 75);
  ctx.stroke();
  ctx.strokeStyle = "#75c2b6";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < 400; i++) {
    const y = 75 - Math.max(-1, Math.min(1, samples[Math.floor((i / 400) * samples.length)]!)) * 65;
    i ? ctx.lineTo(i, y) : ctx.moveTo(i, y);
  }
  ctx.stroke();
  const peak = Math.max(...samples.map(Math.abs));
  el("#level").textContent = peak > 1e-6 ? `${(20 * Math.log10(peak)).toFixed(1)} dB` : "−∞ dB";
  el("#level").classList.toggle("clip", peak > 1);
  requestAnimationFrame(meter);
}
palette();
render();
setZoom(zoom);
meter();
// Inspection hooks exercise the same app document, validation and native session.
Object.assign(window, {
  __denKit: {
    state: () => ({ ...engine.state(), patch: structuredClone(history.patch), build }),
    importPatch: (text: string) => {
      const p = parsePatch(text);
      history.commit(p);
      afterHistory();
    },
    engine,
    validate,
    modules,
  },
});
