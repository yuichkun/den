import type { RegisterOptions } from "@denaudio/worklet";

import { CANONICAL } from "@denaudio/test-utils/signals";

import { drawSpectrum, drawWaveform } from "./viz.js";

const FILE_OPTION = "__file__";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_SECONDS = 30;
const CANONICAL_SR = 48000;

/** Spec for one slider tied to an `AudioParam` on the effect node. */
export interface ParamSpec {
  /** Must match the AudioParam name on the node returned by `makeNode`. */
  name: string;
  min: number;
  max: number;
  step: number;
  initial: number;
  /** Display label; defaults to `name`. */
  label?: string;
}

export interface EffectPageOptions<TNode extends AudioNode> {
  title: string;
  description: string;
  /**
   * The effect's static `register(ctx, opts)`. Called twice per page
   * lifecycle: once on a throw-away `OfflineAudioContext` for the probe
   * (no user gesture needed), then again on the realtime `AudioContext`
   * after the gesture. Both calls hit the same idempotent
   * `registerDenWorklet` under the hood.
   */
  register: (ctx: BaseAudioContext, opts: RegisterOptions) => Promise<void>;
  /**
   * Sync constructor for the live effect node. Called ONLY against the
   * realtime ctx — the helper never feeds an offline ctx here, so no
   * "currentNode aliasing across realtime/offline" trap is possible.
   * `params` is the live slider dictionary; the constructor reads from
   * it so each fresh node starts at the user's current edits.
   */
  makeNode: (ctx: AudioContext, params: Record<string, number>) => TNode;
  /**
   * Apply a slider change to the live node. Effects map the param name
   * to the right `AudioParam` (typically via `setValueAtTime`).
   */
  applyParam?: (node: TNode, name: string, value: number, ctx: AudioContext) => void;
  /** Continuous params surfaced as sliders (defaults to none). */
  params?: ParamSpec[];
  /**
   * Wire `window.__denTier3a` so the Tier3a Playwright spec finds the
   * effect class + signal factories. Called once after the probe
   * completes; the helper sets `window.__denReady = true` on the
   * caller's behalf afterwards.
   */
  bridge: (extras: { workletUrl: string }) => void;
  /**
   * Worklet URL passed straight through to `register(ctx, { workletUrl })`.
   * Pages typically import this via `?url` from the worklet package.
   */
  workletUrl: string;
}

interface LiveState<TNode extends AudioNode> {
  ctx: AudioContext;
  source: AudioBufferSourceNode | null;
  effect: TNode | null;
  analyser: AnalyserNode | null;
  bypass: boolean;
  rafHandle: number;
}

/**
 * Render an effect catalog page. Each `pages/<effect>.ts` is a thin
 * declaration that calls into here; everything else (HTML skeleton,
 * source picker, file upload, transport, Bypass toggle, AbortSignal
 * teardown, AnalyserNode + rAF viz) is centralized so a 50-effect
 * roadmap doesn't mean 50 copies of the same scaffolding.
 *
 * The shape was extracted from the self-contained `pages/gain.ts`
 * implementation that survived several review rounds — every fix
 * we landed against that page (currentNode separation,
 * AbortSignal teardown, pre-decode size cap, temp ctx close,
 * AnalyserNode buffer cache) is codified here so future effects
 * inherit them automatically.
 */
export async function renderEffectPage<TNode extends AudioNode>(
  root: HTMLElement,
  signal: AbortSignal,
  opts: EffectPageOptions<TNode>,
): Promise<void> {
  // ---------- HTML skeleton ----------
  root.innerHTML = `
    <h2>${opts.title}</h2>
    <p>${opts.description}</p>
    <section class="status" id="status">loading…</section>

    <section>
      <div class="row">
        <label for="src">Source</label>
        <select id="src">
          ${Object.keys(CANONICAL)
            .map((n) => `<option value="${n}">${n}</option>`)
            .join("")}
          <option value="${FILE_OPTION}">Custom file…</option>
        </select>
        <input type="file" id="file" accept="audio/*" hidden />
        <span id="fileInfo" class="muted"></span>
      </div>

      ${(opts.params ?? [])
        .map(
          (p) => `
      <div class="row">
        <label for="param-${p.name}">${p.label ?? p.name}</label>
        <input type="range" id="param-${p.name}" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.initial}" />
        <span id="paramVal-${p.name}" class="muted">${p.initial.toFixed(2)}</span>
      </div>`,
        )
        .join("")}

      <div class="row">
        <button id="play">▶ Play</button>
        <button id="bypass">Bypass: OFF</button>
      </div>
    </section>

    <section>
      <h3>Live waveform</h3>
      <canvas id="wave"></canvas>
      <h3 style="margin-top:1rem;">Live spectrum (log freq, 20 Hz → Nyquist)</h3>
      <canvas id="spec"></canvas>
    </section>
  `;

  const $ = <T extends Element>(sel: string): T => root.querySelector<T>(sel)!;
  const status = $<HTMLElement>("#status");
  const srcSel = $<HTMLSelectElement>("#src");
  const fileInput = $<HTMLInputElement>("#file");
  const fileInfo = $<HTMLSpanElement>("#fileInfo");
  const playBtn = $<HTMLButtonElement>("#play");
  const bypassBtn = $<HTMLButtonElement>("#bypass");
  const waveCanvas = $<HTMLCanvasElement>("#wave");
  const specCanvas = $<HTMLCanvasElement>("#spec");

  // ---------- Mutable state ----------
  // Live params dictionary — sliders mutate this; `makeNode` reads it
  // so each fresh node starts at the current slider position.
  const params: Record<string, number> = {};
  for (const p of opts.params ?? []) params[p.name] = p.initial;

  let userBuffer: AudioBuffer | null = null;
  let live: LiveState<TNode> | null = null;

  // ---------- Teardown on navigation ----------
  // Synchronous registration BEFORE the first await so even if probe
  // is mid-fetch when the user navigates, the abort still tears down.
  signal.addEventListener("abort", () => {
    teardownLive();
  });

  function teardownLive(): void {
    if (!live) return;
    if (live.rafHandle) cancelAnimationFrame(live.rafHandle);
    try {
      live.source?.stop();
    } catch {
      /* already stopped */
    }
    live.source?.disconnect();
    live.effect?.disconnect();
    // Effect classes follow the canonical Sub D shape — they expose a
    // `dispose()` that posts the destroy port message AND disconnects.
    // We've already called disconnect(); calling dispose() again is
    // idempotent in our effects (see Gain / Passthrough TSDoc).
    const eff = live.effect as (AudioNode & { dispose?: () => void }) | null;
    eff?.dispose?.();
    live.analyser?.disconnect();
    void live.ctx.close().catch(() => {
      /* close() rejects on already-closed; ignore */
    });
    live = null;
  }

  // ---------- Pipeline probe ----------
  // Runs against a throw-away `OfflineAudioContext` so the catalog can
  // validate the WASM build / worklet bridge before any user gesture
  // (a realtime AudioContext requires one). On Vercel preview without
  // audio permissions this surfaces "pipeline ready ✓" without nagging.
  try {
    const probeCtx = new OfflineAudioContext({
      numberOfChannels: 2,
      length: 128,
      sampleRate: CANONICAL_SR,
    });
    await opts.register(probeCtx, { workletUrl: opts.workletUrl });
    if (signal.aborted) return;
    status.textContent = "pipeline ready ✓ — click Play to start";
  } catch (err) {
    if (signal.aborted) return;
    status.textContent = "pipeline failed — see console";
    throw err;
  }

  // ---------- Tier3a bridge ----------
  // Set BEFORE flipping `__denReady` so the Playwright spec sees both
  // the effect class and CANONICAL the moment it observes ready=true.
  if (signal.aborted) return;
  opts.bridge({ workletUrl: opts.workletUrl });
  window.__denReady = true;

  // ---------- Source picker ----------
  srcSel.addEventListener("change", () => {
    fileInput.hidden = srcSel.value !== FILE_OPTION;
    if (live) restartSource();
  });

  fileInput.addEventListener("change", () => {
    void onFilePick();
  });

  async function onFilePick(): Promise<void> {
    const f = fileInput.files?.[0];
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) {
      fileInfo.textContent = `error: ${(f.size / 1024 / 1024).toFixed(1)} MB > 50 MB cap`;
      return;
    }
    fileInfo.textContent = `decoding ${f.name}…`;
    // `decodeAudioData` requires a realtime AudioContext. Reuse the
    // play ctx if we have one, otherwise spin up a temp ctx and close
    // it after decode (browsers cap concurrent ctxes at ~6 — leaking
    // them on every file pick would brick the page until reload).
    const tempCtx = live?.ctx ?? new AudioContext();
    try {
      const decoded = await tempCtx.decodeAudioData((await f.arrayBuffer()).slice(0));
      if (decoded.duration > MAX_FILE_SECONDS) {
        fileInfo.textContent = `error: ${decoded.duration.toFixed(1)}s > ${MAX_FILE_SECONDS}s cap`;
        return;
      }
      // Multichannel handling is delegated to Web Audio: the effect
      // node has `outputChannelCount: [2]` and the default
      // `channelInterpretation: "speakers"`, so a 5.1 source gets
      // proper ITU-R BS.775 downmix to stereo automatically. No
      // need (or correctness benefit) to downmix in JS.
      userBuffer = decoded;
      fileInfo.textContent = `${f.name} — ${decoded.duration.toFixed(2)}s, ${decoded.sampleRate} Hz, ${decoded.numberOfChannels}ch`;
      srcSel.value = FILE_OPTION;
      fileInput.hidden = false;
      if (live) restartSource();
    } catch (err) {
      fileInfo.textContent = `error: ${(err as Error).message}`;
    } finally {
      if (tempCtx !== live?.ctx) {
        try {
          await tempCtx.close();
        } catch {
          /* close() throws on already-closed; ignore */
        }
      }
    }
  }

  // ---------- Param sliders ----------
  for (const p of opts.params ?? []) {
    const slider = $<HTMLInputElement>(`#param-${p.name}`);
    const valueLabel = $<HTMLSpanElement>(`#paramVal-${p.name}`);
    slider.addEventListener("input", () => {
      const v = Number(slider.value);
      params[p.name] = v;
      valueLabel.textContent = v.toFixed(2);
      if (live?.effect && opts.applyParam) {
        try {
          opts.applyParam(live.effect, p.name, v, live.ctx);
        } catch (err) {
          console.warn(`[den] applyParam(${p.name}) failed:`, (err as Error).message);
        }
      }
    });
  }

  // ---------- Bypass toggle ----------
  bypassBtn.addEventListener("click", () => {
    if (!live) return;
    live.bypass = !live.bypass;
    bypassBtn.textContent = `Bypass: ${live.bypass ? "ON" : "OFF"}`;
    reroute();
  });

  // ---------- Transport ----------
  playBtn.addEventListener("click", () => {
    if (live) stop();
    else void start();
  });

  async function start(): Promise<void> {
    const ctx = new AudioContext();
    try {
      if (ctx.state === "suspended") await ctx.resume();
      await opts.register(ctx, { workletUrl: opts.workletUrl });
    } catch (err) {
      console.error("[den] start failed:", err);
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
      return;
    }
    if (signal.aborted) {
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
      return;
    }

    const effect = opts.makeNode(ctx, params);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    const source = ctx.createBufferSource();
    try {
      source.buffer = buildSourceBuffer(ctx);
    } catch (err) {
      fileInfo.textContent = `cannot start: ${(err as Error).message}`;
      const eff = effect as AudioNode & { dispose?: () => void };
      eff.dispose?.();
      analyser.disconnect();
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
      return;
    }
    source.loop = true;

    live = {
      ctx,
      source,
      effect,
      analyser,
      bypass: false,
      rafHandle: 0,
    };
    bypassBtn.textContent = "Bypass: OFF";
    reroute();
    source.start();
    playBtn.textContent = "■ Stop";
    drawFrame();
  }

  function stop(): void {
    teardownLive();
    playBtn.textContent = "▶ Play";
    bypassBtn.textContent = "Bypass: OFF";
    clearViz();
  }

  function restartSource(): void {
    if (!live) return;
    try {
      live.source?.stop();
    } catch {
      /* already stopped */
    }
    live.source?.disconnect();
    const fresh = live.ctx.createBufferSource();
    try {
      fresh.buffer = buildSourceBuffer(live.ctx);
    } catch (err) {
      console.warn("[den] cannot rebuild source:", (err as Error).message);
      stop();
      return;
    }
    fresh.loop = true;
    live.source = fresh;
    reroute();
    fresh.start();
  }

  function reroute(): void {
    if (!live?.source || !live.analyser) return;
    live.source.disconnect();
    live.effect?.disconnect();
    if (live.bypass || !live.effect) {
      live.source.connect(live.analyser).connect(live.ctx.destination);
    } else {
      live.source.connect(live.effect).connect(live.analyser).connect(live.ctx.destination);
    }
  }

  function buildSourceBuffer(c: AudioContext): AudioBuffer {
    if (srcSel.value === FILE_OPTION) {
      if (!userBuffer) throw new Error("no file loaded");
      // AudioBuffer is portable across contexts per Web Audio §1.4;
      // sample-rate mismatch is auto-corrected by the source node's
      // playbackRate compensation.
      return userBuffer;
    }
    const factory = CANONICAL[srcSel.value];
    if (!factory) throw new Error(`unknown signal: ${srcSel.value}`);
    const src = factory();
    // CANONICAL factories return `Float32Array<ArrayBufferLike>`; wrap
    // in a fresh ArrayBuffer-backed view so `copyToChannel`'s strict
    // signature accepts it.
    const mono = new Float32Array(src.length);
    mono.set(src);
    const buf = c.createBuffer(2, mono.length, CANONICAL_SR);
    buf.copyToChannel(mono, 0);
    buf.copyToChannel(mono, 1);
    return buf;
  }

  function drawFrame(): void {
    if (!live?.analyser) return;
    drawWaveform(waveCanvas, live.analyser);
    drawSpectrum(specCanvas, live.analyser);
    live.rafHandle = requestAnimationFrame(drawFrame);
  }

  function clearViz(): void {
    for (const c of [waveCanvas, specCanvas]) {
      const g = c.getContext("2d");
      if (g) {
        g.fillStyle = "#0a0a0a";
        g.fillRect(0, 0, c.width, c.height);
      }
    }
  }
}
