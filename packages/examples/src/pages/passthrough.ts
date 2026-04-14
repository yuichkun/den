import { Passthrough } from "@denaudio/effects";
import { CANONICAL } from "@denaudio/test-utils/signals";
import workletUrl from "../../../worklet/dist/processor.js?url";

import "../test-bridge.js";
import { drawSpectrum, drawWaveform } from "../lib/viz.js";

const FILE_OPTION = "__file__";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_SECONDS = 30;
const CANONICAL_SR = 48000;

export const name = "Passthrough";

/**
 * Passthrough catalog page. Self-contained — no shared `mountEffectPage`
 * helper. Same audio-graph shape as `pages/gain.ts` minus the gain
 * slider; Bypass toggle is kept so reviewers can flip it on/off and
 * confirm output IS bit-identical to input either way.
 */
export async function render(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <h2>Passthrough (Sub B stub)</h2>
    <p>Identity: output equals input. Used to validate the pipeline end-to-end.</p>
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

  let ctx: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let effect: Passthrough | null = null;
  let analyser: AnalyserNode | null = null;
  let userBuffer: AudioBuffer | null = null;
  let bypass = false;
  let rafHandle = 0;

  try {
    const probeCtx = new OfflineAudioContext({
      numberOfChannels: 2,
      length: 128,
      sampleRate: CANONICAL_SR,
    });
    await Passthrough.register(probeCtx, { workletUrl });
    status.textContent = "pipeline ready ✓ — click Play to start";
  } catch (err) {
    status.textContent = "pipeline failed — see console";
    throw err;
  }

  window.__denTier3a = { ...window.__denTier3a, Passthrough, CANONICAL, workletUrl };
  window.__denReady = true;

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
    // Same close-temp-ctx pattern as `pages/gain.ts` — see that file's
    // expanded comment. Without this, repeated file picks before Play
    // exhaust the browser's AudioContext limit.
    const tempCtx = ctx ?? new AudioContext();
    try {
      const decoded = await tempCtx.decodeAudioData((await f.arrayBuffer()).slice(0));
      if (decoded.duration > MAX_FILE_SECONDS) {
        fileInfo.textContent = `error: ${decoded.duration.toFixed(1)}s > ${MAX_FILE_SECONDS}s cap`;
        return;
      }
      userBuffer = decoded;
      fileInfo.textContent = `${f.name} — ${decoded.duration.toFixed(2)}s, ${decoded.sampleRate} Hz, ${decoded.numberOfChannels}ch`;
      srcSel.value = FILE_OPTION;
      fileInput.hidden = false;
      if (isPlaying()) restartSource();
    } catch (err) {
      fileInfo.textContent = `error: ${(err as Error).message}`;
    } finally {
      if (tempCtx !== ctx) {
        try {
          await tempCtx.close();
        } catch {
          /* close() throws on already-closed contexts; ignore */
        }
      }
    }
  }

  bypassBtn.addEventListener("click", () => {
    bypass = !bypass;
    bypassBtn.textContent = `Bypass: ${bypass ? "ON" : "OFF"}`;
    if (isPlaying()) reroute();
  });

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
      await Passthrough.register(ctx, { workletUrl });
    }
    if (ctx.state === "suspended") await ctx.resume();

    effect = new Passthrough(ctx);
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
      console.warn("[passthrough] cannot rebuild source:", (err as Error).message);
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
      return userBuffer;
    }
    const factory = CANONICAL[srcSel.value];
    if (!factory) throw new Error(`unknown signal: ${srcSel.value}`);
    const src = factory();
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
