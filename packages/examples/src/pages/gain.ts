import { Gain } from "@denaudio/effects";
import { CANONICAL } from "@denaudio/test-utils/signals";
import workletUrl from "../../../worklet/dist/processor.js?url";

import "../test-bridge.js";
import { drawSpectrum, drawWaveform } from "../lib/viz.js";

const FILE_OPTION = "__file__";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_SECONDS = 30;
const CANONICAL_SR = 48000;

export const name = "Gain";

/**
 * Gain catalog page. Self-contained — no shared `mountEffectPage` helper
 * (the previous abstraction layer leaked too many subtle bugs around
 * `currentNode` aliasing and offline-render lifecycles). Sub E will
 * design the abstraction once a third effect exists.
 *
 * Audio graph (one AudioContext per page lifecycle):
 *   source → [effect | bypass] → analyser → destination
 *
 * The analyser drives realtime waveform + spectrum via
 * `requestAnimationFrame`. No offline rendering, no per-slider WASM
 * instances, no debounced refresh dance.
 */
export async function render(root: HTMLElement, signal: AbortSignal): Promise<void> {
  // ---------- HTML skeleton ----------
  root.innerHTML = `
    <h2>Gain</h2>
    <p>Linear per-channel multiplier with 20 ms 1-pole smoothing.</p>
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

      <div class="row">
        <label for="gain">gain</label>
        <input type="range" id="gain" min="0" max="2" step="0.01" value="1" />
        <span id="gainVal" class="muted">1.00</span>
      </div>

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
  const gainSlider = $<HTMLInputElement>("#gain");
  const gainVal = $<HTMLSpanElement>("#gainVal");
  const playBtn = $<HTMLButtonElement>("#play");
  const bypassBtn = $<HTMLButtonElement>("#bypass");
  const waveCanvas = $<HTMLCanvasElement>("#wave");
  const specCanvas = $<HTMLCanvasElement>("#spec");

  // ---------- State ----------
  let ctx: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let effect: Gain | null = null;
  let analyser: AnalyserNode | null = null;
  let userBuffer: AudioBuffer | null = null;
  let bypass = false;
  let rafHandle = 0;

  // ---------- Teardown on navigation ----------
  // `main.ts` aborts the previous page's signal before mounting the
  // new one. Register cleanup HERE (synchronously, before the first
  // await) so even if `Gain.register` is mid-fetch when the user
  // navigates, the eventual abort still tears down our audio + RAF.
  signal.addEventListener("abort", () => {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = 0;
    try {
      source?.stop();
    } catch {
      /* already stopped */
    }
    source?.disconnect();
    effect?.dispose();
    analyser?.disconnect();
    if (ctx) {
      void ctx.close().catch(() => {
        /* close() rejects on already-closed; ignore */
      });
    }
  });

  // ---------- Pipeline probe ----------
  // Runs on a throw-away OfflineAudioContext so we can validate the
  // WASM build / worklet bridge before any user gesture (the realtime
  // AudioContext requires one). On Vercel preview without audio
  // permissions this surfaces "pipeline ready ✓" without nagging.
  try {
    const probeCtx = new OfflineAudioContext({
      numberOfChannels: 2,
      length: 128,
      sampleRate: CANONICAL_SR,
    });
    await Gain.register(probeCtx, { workletUrl });
    if (signal.aborted) return;
    status.textContent = "pipeline ready ✓ — click Play to start";
  } catch (err) {
    if (signal.aborted) return;
    status.textContent = "pipeline failed — see console";
    throw err;
  }

  // ---------- Tier3a bridge ----------
  // Set BEFORE flipping `__denReady` so the Playwright spec sees both
  // `Gain` and `CANONICAL` the moment it observes ready=true. Bail if
  // the user navigated away mid-probe — main.ts has already cleared
  // the bridge for the new page and we must not clobber it.
  if (signal.aborted) return;
  window.__denTier3a = { ...window.__denTier3a, Gain, CANONICAL, workletUrl };
  window.__denReady = true;

  // ---------- Source picker ----------
  srcSel.addEventListener("change", () => {
    fileInput.hidden = srcSel.value !== FILE_OPTION;
    if (isPlaying()) restartSource();
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
    // `decodeAudioData` must run against an actual AudioContext (not
    // OAC). Reuse the play ctx if we have one, otherwise spin up a
    // throw-away realtime ctx — the resulting `AudioBuffer` is
    // portable across contexts per Web Audio §1.4 (decoded data is
    // not tied to the context that created it), so we can close the
    // temp ctx as soon as decode completes. Without this close,
    // re-picking files a few times would exhaust the browser's
    // ~6-AudioContext limit and brick the page until reload.
    const tempCtx = ctx ?? new AudioContext();
    try {
      // `slice(0)` clones the ArrayBuffer; `decodeAudioData` neuters
      // the input per spec, and a clone lets the user re-pick the
      // same file later via a fresh `file.arrayBuffer()` call.
      const decoded = await tempCtx.decodeAudioData((await f.arrayBuffer()).slice(0));
      if (decoded.duration > MAX_FILE_SECONDS) {
        fileInfo.textContent = `error: ${decoded.duration.toFixed(1)}s > ${MAX_FILE_SECONDS}s cap`;
        return;
      }
      userBuffer = decoded;
      fileInfo.textContent = `${f.name} — ${decoded.duration.toFixed(2)}s, ${decoded.sampleRate} Hz, ${decoded.numberOfChannels}ch`;
      // Auto-select the file as the active source so the connection
      // between picker and source dropdown is obvious.
      srcSel.value = FILE_OPTION;
      fileInput.hidden = false;
      if (isPlaying()) restartSource();
    } catch (err) {
      fileInfo.textContent = `error: ${(err as Error).message}`;
    } finally {
      // Only close if we created the temp ctx — never close the live
      // play ctx out from under the user.
      if (tempCtx !== ctx) {
        try {
          await tempCtx.close();
        } catch {
          /* close() throws on already-closed contexts; ignore */
        }
      }
    }
  }

  // ---------- Gain slider ----------
  gainSlider.addEventListener("input", () => {
    const v = Number(gainSlider.value);
    gainVal.textContent = v.toFixed(2);
    if (effect && ctx) {
      try {
        effect.gain.setValueAtTime(v, ctx.currentTime);
      } catch (err) {
        // Closed contexts / disposed nodes throw here; silently
        // ignore so the slider UI stays responsive.
        console.warn("[gain] setValueAtTime failed:", (err as Error).message);
      }
    }
  });

  // ---------- Bypass toggle ----------
  bypassBtn.addEventListener("click", () => {
    bypass = !bypass;
    bypassBtn.textContent = `Bypass: ${bypass ? "ON" : "OFF"}`;
    if (isPlaying()) reroute();
  });

  // ---------- Transport ----------
  playBtn.addEventListener("click", () => {
    if (isPlaying()) stop();
    else void start();
  });

  function isPlaying(): boolean {
    return source !== null;
  }

  async function start(): Promise<void> {
    if (!ctx) {
      ctx = new AudioContext();
      await Gain.register(ctx, { workletUrl });
    }
    if (ctx.state === "suspended") await ctx.resume();

    // Build effect + analyser per Play. Gain seeded with the slider's
    // current value so the very first sample is at user-requested
    // level — no audible smoother transient on startup.
    effect = new Gain(ctx, { gain: Number(gainSlider.value) });
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    source = ctx.createBufferSource();
    try {
      source.buffer = buildSourceBuffer(ctx);
    } catch (err) {
      fileInfo.textContent = `cannot start: ${(err as Error).message}`;
      stop();
      return;
    }
    source.loop = true;

    reroute();
    source.start();
    playBtn.textContent = "■ Stop";
    drawFrame();
  }

  function stop(): void {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = 0;
    try {
      source?.stop();
    } catch {
      /* already stopped */
    }
    source?.disconnect();
    effect?.dispose();
    analyser?.disconnect();
    source = null;
    effect = null;
    analyser = null;
    playBtn.textContent = "▶ Play";
    clearViz();
  }

  function restartSource(): void {
    if (!ctx || !analyser) return;
    // AudioBufferSourceNode is one-shot per Web Audio spec — every
    // signal/file change rebuilds it. Effect + analyser persist so
    // gain state and visualization don't reset on source switch.
    try {
      source?.stop();
    } catch {
      /* already stopped */
    }
    source?.disconnect();
    source = ctx.createBufferSource();
    try {
      source.buffer = buildSourceBuffer(ctx);
    } catch (err) {
      console.warn("[gain] cannot rebuild source:", (err as Error).message);
      stop();
      return;
    }
    source.loop = true;
    reroute();
    source.start();
  }

  function reroute(): void {
    if (!ctx || !source || !analyser) return;
    source.disconnect();
    effect?.disconnect();
    if (bypass || !effect) {
      source.connect(analyser).connect(ctx.destination);
    } else {
      source.connect(effect).connect(analyser).connect(ctx.destination);
    }
  }

  function buildSourceBuffer(c: AudioContext): AudioBuffer {
    if (srcSel.value === FILE_OPTION) {
      if (!userBuffer) throw new Error("no file loaded");
      // AudioBuffer is portable across contexts. Sample-rate
      // mismatch is auto-corrected by AudioBufferSourceNode's
      // playbackRate compensation.
      return userBuffer;
    }
    const factory = CANONICAL[srcSel.value];
    if (!factory) throw new Error(`unknown signal: ${srcSel.value}`);
    const src = factory();
    // The CANONICAL factories return `Float32Array<ArrayBufferLike>`;
    // wrap in a fresh ArrayBuffer-backed view so `copyToChannel`'s
    // strict `Float32Array<ArrayBuffer>` parameter accepts it.
    const mono = new Float32Array(src.length);
    mono.set(src);
    const buf = c.createBuffer(2, mono.length, CANONICAL_SR);
    buf.copyToChannel(mono, 0);
    buf.copyToChannel(mono, 1);
    return buf;
  }

  function drawFrame(): void {
    if (!analyser) return;
    drawWaveform(waveCanvas, analyser);
    drawSpectrum(specCanvas, analyser);
    rafHandle = requestAnimationFrame(drawFrame);
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
