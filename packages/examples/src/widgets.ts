import { CANONICAL } from "@denaudio/test-utils/signals";
import FFT from "fft.js";

type MakeEffectNode = (ctx: AudioContext) => Promise<AudioNode>;

const BUFFER_SR = 48000;

/** Sentinel `<select>` value used by the A/B player + file picker integration. */
export const USER_FILE_OPTION = "__user_file__";

function makeSourceBuffer(
  ctx: AudioContext | OfflineAudioContext,
  signalName: string,
  getUserFile?: () => AudioBuffer | null,
): AudioBuffer {
  if (signalName === USER_FILE_OPTION) {
    const buf = getUserFile?.();
    if (!buf) throw new Error("no user file loaded");
    // For offline contexts the user buffer must be re-created against
    // the offline ctx because each `AudioBuffer` is bound to a
    // sample-rate; copy channel-by-channel into a fresh buffer.
    if (ctx instanceof OfflineAudioContext && buf.sampleRate !== ctx.sampleRate) {
      const out = ctx.createBuffer(buf.numberOfChannels, buf.length, ctx.sampleRate);
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        out.copyToChannel(buf.getChannelData(ch), ch);
      }
      return out;
    }
    return buf;
  }
  const factory = CANONICAL[signalName];
  if (!factory) throw new Error(`unknown signal: ${signalName}`);
  // The CANONICAL factories return `Float32Array` (i.e.
  // `Float32Array<ArrayBufferLike>` under the stricter DOM types). Wrap
  // in a fresh ArrayBuffer-backed view so copyToChannel accepts it.
  const src = factory();
  const mono = new Float32Array(src.length);
  mono.set(src);
  const buf = ctx.createBuffer(2, mono.length, BUFFER_SR);
  buf.copyToChannel(mono, 0);
  buf.copyToChannel(mono, 1);
  return buf;
}

// Realtime A/B player: picks a canonical signal, routes it through
// either the dry path or the effect node. A wet/dry slider crossfades
// via two GainNodes. The last rendered buffer is captured (offline) so
// wave / spec widgets can draw it.
export interface ABPlayerHandle {
  getLastRendered(): Promise<AudioBuffer>;
  setSignal(name: string): void;
  destroy(): void;
  /**
   * Update the "user file" `<option>` after the file picker emits a
   * change. Pass `null` to disable the option (no file loaded), or a
   * short label (typically the file name) to enable it. Only does
   * anything when the player was constructed with a `getUserFile`
   * callback; otherwise the option doesn't exist and the call no-ops.
   */
  refreshUserFile(label: string | null): void;
}

export function mountABPlayer(
  container: HTMLElement,
  ctx: AudioContext,
  makeEffectNode: MakeEffectNode,
  // Optional callback fired whenever the user picks a different
  // signal. The catalog page wires this to refreshViz so the
  // wave/spectrogram canvases re-render against the new signal
  // without forcing the user to hit "Re-render wave + spec".
  onSignalChange?: () => void | Promise<void>,
  // Optional accessor for a user-loaded `AudioBuffer` (from
  // `mountFilePicker`). When provided, the signal dropdown gains a
  // "user file" entry; selecting it routes the player at the file
  // instead of a CANONICAL signal. The dropdown entry is disabled
  // when `getUserFile()` returns `null` so users can't accidentally
  // select an empty source.
  getUserFile?: () => AudioBuffer | null,
): ABPlayerHandle {
  const userFileOptionHtml = getUserFile
    ? `<option value="${USER_FILE_OPTION}" disabled>user file (none loaded)</option>`
    : "";
  container.innerHTML = `
    <h3>A / B player</h3>
    <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap;">
      <label>Signal <select class="sig">
        ${Object.keys(CANONICAL)
          .map((n) => `<option value="${n}">${n}</option>`)
          .join("")}
        ${userFileOptionHtml}
      </select></label>
      <button class="play">Play</button>
      <button class="stop">Stop</button>
      <label class="slider" style="min-width:240px;">
        <span>Wet/Dry</span>
        <input type="range" class="mix" min="0" max="1" step="0.01" value="1" />
        <span class="value">1.00</span>
      </label>
    </div>
  `;

  const sigSel = container.querySelector<HTMLSelectElement>(".sig")!;
  const playBtn = container.querySelector<HTMLButtonElement>(".play")!;
  const stopBtn = container.querySelector<HTMLButtonElement>(".stop")!;
  const mix = container.querySelector<HTMLInputElement>(".mix")!;
  const mixLabel = container.querySelector<HTMLSpanElement>(".value")!;

  let current: {
    src: AudioBufferSourceNode;
    dry: GainNode;
    wet: GainNode;
    effect: AudioNode;
  } | null = null;

  async function play(): Promise<void> {
    stop();
    if (ctx.state === "suspended") await ctx.resume();
    const effect = await makeEffectNode(ctx);
    const src = ctx.createBufferSource();
    src.buffer = makeSourceBuffer(ctx, sigSel.value, getUserFile);
    src.loop = true;
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    applyMix(dry, wet, Number(mix.value));
    src.connect(dry).connect(ctx.destination);
    src.connect(effect).connect(wet).connect(ctx.destination);
    src.start();
    current = { src, dry, wet, effect };
  }

  function stop(): void {
    if (!current) return;
    try {
      current.src.stop();
    } catch {
      /* already stopped */
    }
    current.src.disconnect();
    current.dry.disconnect();
    current.wet.disconnect();
    try {
      current.effect.disconnect();
    } catch {
      /* noop */
    }
    current = null;
  }

  function applyMix(dry: GainNode, wet: GainNode, v: number): void {
    dry.gain.value = 1 - v;
    wet.gain.value = v;
  }

  mix.addEventListener("input", () => {
    mixLabel.textContent = Number(mix.value).toFixed(2);
    if (current) applyMix(current.dry, current.wet, Number(mix.value));
  });
  playBtn.addEventListener("click", () => {
    void play();
  });
  stopBtn.addEventListener("click", stop);
  sigSel.addEventListener("change", () => {
    // If the player is currently playing, switch the source signal
    // immediately so the user hears the new selection. The
    // visualizer refresh runs regardless via onSignalChange.
    if (current) void play();
    void onSignalChange?.();
  });

  return {
    async getLastRendered(): Promise<AudioBuffer> {
      // Build the offline ctx FIRST so the user-file branch of
      // `makeSourceBuffer` can reuse the offline ctx's sample rate
      // when copying channels.
      const probeBuf = makeSourceBuffer(ctx, sigSel.value, getUserFile);
      const off = new OfflineAudioContext({
        numberOfChannels: 2,
        length: probeBuf.length,
        sampleRate: BUFFER_SR,
      });
      const sigBuf = makeSourceBuffer(off, sigSel.value, getUserFile);
      const effect = await makeEffectNode(off as unknown as AudioContext);
      const src = off.createBufferSource();
      src.buffer = sigBuf;
      src.connect(effect).connect(off.destination);
      src.start();
      return off.startRendering();
    },
    setSignal(name: string): void {
      sigSel.value = name;
    },
    destroy(): void {
      stop();
    },
    refreshUserFile(label: string | null): void {
      const opt = sigSel.querySelector<HTMLOptionElement>(`option[value="${USER_FILE_OPTION}"]`);
      if (!opt) return;
      if (label) {
        opt.disabled = false;
        opt.textContent = `user file: ${label}`;
      } else {
        opt.disabled = true;
        opt.textContent = "user file (none loaded)";
        if (sigSel.value === USER_FILE_OPTION) {
          // User file was cleared while selected — fall back to first
          // canonical signal so play()/getLastRendered don't throw.
          const first = Object.keys(CANONICAL)[0];
          if (first) sigSel.value = first;
        }
      }
    },
  };
}

export interface ParamSliderOptions {
  min: number;
  max: number;
  step: number;
  initial: number;
  onChange: (v: number) => void;
  label?: string;
}

export function mountParamSlider(
  container: HTMLElement,
  paramName: string,
  options: ParamSliderOptions,
): void {
  const label = options.label ?? paramName;
  const wrap = document.createElement("label");
  wrap.className = "slider";
  wrap.innerHTML = `
    <span>${label}</span>
    <input type="range" min="${options.min}" max="${options.max}" step="${options.step}" value="${options.initial}" />
    <span class="value">${options.initial}</span>
  `;
  const input = wrap.querySelector<HTMLInputElement>("input")!;
  const value = wrap.querySelector<HTMLSpanElement>(".value")!;
  input.addEventListener("input", () => {
    const v = Number(input.value);
    value.textContent = v.toFixed(3);
    options.onChange(v);
  });
  container.appendChild(wrap);
}

export function mountWaveform(container: HTMLElement, buffer: AudioBuffer): void {
  container.innerHTML = `<h3>Waveform — effect output (L top / R bottom)</h3><canvas></canvas>`;
  const canvas = container.querySelector<HTMLCanvasElement>("canvas")!;
  const dpr = globalThis.devicePixelRatio ?? 1;
  const w = (canvas.width = canvas.clientWidth * dpr);
  const h = (canvas.height = canvas.clientHeight * dpr);
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);

  const numCh = Math.min(2, buffer.numberOfChannels);
  // Stack L and R vertically (DAW-style) so both stay visible even when
  // they're identical (Passthrough has L==R for our test signals — if
  // we drew them in the same band the second would completely hide
  // the first).
  for (let ch = 0; ch < numCh; ch++) {
    const data = buffer.getChannelData(ch);
    const bins = w;
    const samplesPerBin = Math.max(1, Math.floor(data.length / bins));
    const bandTop = numCh === 1 ? 0 : (ch * h) / 2;
    const bandHeight = numCh === 1 ? h : h / 2;
    const yMid = bandTop + bandHeight / 2;
    const yScale = bandHeight / 2;

    // Faint center line per band for amplitude reference.
    g.strokeStyle = "#222";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, yMid);
    g.lineTo(w, yMid);
    g.stroke();

    g.strokeStyle = ch === 0 ? "#5b6cff" : "#ff6c5b";
    g.beginPath();
    for (let x = 0; x < bins; x++) {
      let min = 1,
        max = -1;
      const base = x * samplesPerBin;
      for (let i = 0; i < samplesPerBin; i++) {
        const s = data[base + i] ?? 0;
        if (s < min) min = s;
        if (s > max) max = s;
      }
      const yMin = yMid - min * yScale;
      const yMax = yMid - max * yScale;
      g.moveTo(x, yMin);
      g.lineTo(x, yMax);
    }
    g.stroke();
  }
}

const SPEC_FFT = 1024;
const SPEC_HOP = 512;

interface FftInstance {
  realTransform(output: number[], input: number[] | Float32Array): void;
  completeSpectrum(output: number[]): void;
}

interface FftConstructor {
  new (size: number): FftInstance;
}

export function mountSpectrogram(container: HTMLElement, buffer: AudioBuffer): void {
  container.innerHTML = `<h3>Spectrogram — effect output (L top / R bottom, log-freq 20 Hz → Nyquist)</h3><canvas></canvas>`;
  const canvas = container.querySelector<HTMLCanvasElement>("canvas")!;
  const dpr = globalThis.devicePixelRatio ?? 1;
  const w = (canvas.width = canvas.clientWidth * dpr);
  const h = (canvas.height = canvas.clientHeight * dpr);
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);

  const sr = buffer.sampleRate;
  const numCh = Math.min(2, buffer.numberOfChannels);
  const bandH = numCh === 1 ? h : Math.floor(h / 2);

  const fft = new (FFT as unknown as FftConstructor)(SPEC_FFT);
  const outSpec: number[] = Array.from({ length: SPEC_FFT * 2 }, () => 0);
  const window = new Float32Array(SPEC_FFT);
  for (let i = 0; i < SPEC_FFT; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (SPEC_FFT - 1)));
  }

  // Precompute display-row → FFT-bin lookup using a log-frequency axis
  // (top of band = Nyquist, bottom = ~20 Hz). Without this remap a log
  // chirp shows up as a near-vertical streak on the right; with it, the
  // chirp draws as the expected diagonal sweep. Same lookup is reused
  // for both L and R bands since each band has the same height.
  const F_MIN = 20;
  const F_MAX = sr / 2;
  const binLookup = new Int16Array(bandH);
  for (let row = 0; row < bandH; row++) {
    const yNorm = row / Math.max(1, bandH - 1);
    const freq = F_MAX * Math.pow(F_MIN / F_MAX, yNorm);
    binLookup[row] = Math.min(SPEC_FFT / 2 - 1, Math.max(0, Math.round((freq * SPEC_FFT) / sr)));
  }

  // Normalize so a full-scale sinusoid lands near 0 dBFS rather than
  // saturating at ~+50 dBFS. Hann window halves the windowed energy,
  // so peak FFT magnitude for amplitude A is roughly A*N/4; dividing
  // by N/2 gets us close to A in linear scale.
  const NORM = SPEC_FFT / 2;

  for (let ch = 0; ch < numCh; ch++) {
    const samples = buffer.getChannelData(ch);
    const frames = Math.max(1, Math.floor((samples.length - SPEC_FFT) / SPEC_HOP));

    // Render this channel into its own offscreen canvas at native
    // (frames × bandH) resolution, then drawImage-scale onto the
    // display canvas. Drawing canvas-to-itself with overlapping
    // src/dest is undefined per the Canvas2D spec.
    const off = document.createElement("canvas");
    off.width = frames;
    off.height = bandH;
    const og = off.getContext("2d")!;
    const imageData = og.createImageData(frames, bandH);
    const data = imageData.data;

    const mags = new Float32Array(SPEC_FFT / 2);
    const input: number[] = Array.from({ length: SPEC_FFT }, () => 0);
    // L gets the existing blue tint, R gets a red tint so the two
    // bands are visually distinguishable even when L == R.
    const tint = ch === 0 ? "blue" : "red";

    for (let f = 0; f < frames; f++) {
      const base = f * SPEC_HOP;
      for (let i = 0; i < SPEC_FFT; i++) {
        input[i] = (samples[base + i] ?? 0) * (window[i] ?? 0);
      }
      fft.realTransform(outSpec, input);
      fft.completeSpectrum(outSpec);
      for (let k = 0; k < SPEC_FFT / 2; k++) {
        const re = outSpec[2 * k] ?? 0;
        const im = outSpec[2 * k + 1] ?? 0;
        mags[k] = Math.sqrt(re * re + im * im) / NORM;
      }
      for (let row = 0; row < bandH; row++) {
        const k = binLookup[row]!;
        const mag = mags[k] ?? 0;
        const db = 20 * Math.log10(mag + 1e-9);
        const norm = Math.max(0, Math.min(1, (db + 96) / 96));
        const pxIdx = (row * frames + f) * 4;
        const c = Math.floor(norm * 255);
        const accent = Math.floor(norm * 180 + 60);
        if (tint === "blue") {
          data[pxIdx] = c;
          data[pxIdx + 1] = c;
          data[pxIdx + 2] = accent;
        } else {
          data[pxIdx] = accent;
          data[pxIdx + 1] = c;
          data[pxIdx + 2] = c;
        }
        data[pxIdx + 3] = 255;
      }
    }
    og.putImageData(imageData, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(off, 0, 0, frames, bandH, 0, ch * bandH, w, bandH);
  }

  // Faint divider between the two bands (matches the waveform
  // widget's visual style).
  if (numCh === 2) {
    g.fillStyle = "#222";
    g.fillRect(0, bandH - 1, w, 1);
  }
}

export interface FilePickerHandle {
  /** Currently loaded buffer, or `null` if no file is loaded. */
  current(): AudioBuffer | null;
  /** Subscribe to file-change events. The buffer is null on clear, AudioBuffer on load. */
  onChange(cb: (buf: AudioBuffer | null, label: string | null) => void): void;
}

export interface FilePickerOptions {
  /** Reject files longer than this many seconds. Default 30 s. */
  maxDurationSec?: number;
}

/**
 * Mount a file picker that decodes the chosen audio file into an
 * `AudioBuffer` against the given `AudioContext`. Mono is up-mixed to
 * stereo (L duplicated into R); ≥3-channel files are down-mixed to the
 * first two channels. Files longer than `maxDurationSec` (default 30 s)
 * are rejected — both to bound memory for offline rendering and because
 * the catalog page is for testing effects, not playing albums.
 *
 * Requires an `AudioContext` (not `OfflineAudioContext`) because
 * `decodeAudioData` is only universally implemented on realtime
 * contexts. Catalog pages that only get a realtime ctx after the user
 * gesture should mount the file picker after the gesture.
 */
export function mountFilePicker(
  container: HTMLElement,
  ctx: AudioContext,
  options: FilePickerOptions = {},
): FilePickerHandle {
  const maxDur = options.maxDurationSec ?? 30;
  container.innerHTML = `
    <h3>User file</h3>
    <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap;">
      <input type="file" accept="audio/*" class="file" />
      <button class="clear" hidden>Clear</button>
      <span class="status" style="opacity:0.85;">no file</span>
    </div>
    <p style="opacity:0.6;font-size:0.85em;margin:0.5rem 0;">
      Pick a small audio file (max ${maxDur} s, any sample rate, mono auto-upmixed
      to stereo). The file becomes a "user file" entry in the A/B player's
      signal selector above.
    </p>
  `;

  const fileInput = container.querySelector<HTMLInputElement>(".file")!;
  const clearBtn = container.querySelector<HTMLButtonElement>(".clear")!;
  const status = container.querySelector<HTMLSpanElement>(".status")!;

  let buffer: AudioBuffer | null = null;
  let label: string | null = null;
  const subscribers = new Set<(b: AudioBuffer | null, l: string | null) => void>();

  function notify(): void {
    for (const cb of subscribers) cb(buffer, label);
  }

  function setStatus(text: string, isError = false): void {
    status.textContent = text;
    status.style.color = isError ? "#ff8080" : "";
  }

  fileInput.addEventListener("change", () => {
    void (async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      setStatus(`decoding ${file.name}…`);
      try {
        const arrayBuf = await file.arrayBuffer();
        // Some browsers (Safari historically) reject the same
        // ArrayBuffer being passed to decodeAudioData twice; clone via
        // `slice(0)` so a re-pick of the same file works.
        const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
        if (decoded.duration > maxDur) {
          throw new Error(`file is ${decoded.duration.toFixed(1)} s, max is ${maxDur} s`);
        }
        const stereo = upmixToStereo(ctx, decoded);
        buffer = stereo;
        label = file.name;
        clearBtn.hidden = false;
        setStatus(
          `loaded: ${file.name} (${stereo.duration.toFixed(2)}s, ${stereo.sampleRate} Hz, ${decoded.numberOfChannels}ch → 2ch)`,
        );
        notify();
      } catch (err) {
        buffer = null;
        label = null;
        clearBtn.hidden = true;
        setStatus(`error: ${(err as Error).message}`, true);
        notify();
      }
    })();
  });

  clearBtn.addEventListener("click", () => {
    buffer = null;
    label = null;
    fileInput.value = "";
    clearBtn.hidden = true;
    setStatus("no file");
    notify();
  });

  return {
    current(): AudioBuffer | null {
      return buffer;
    },
    onChange(cb): void {
      subscribers.add(cb);
    },
  };
}

function upmixToStereo(ctx: AudioContext, src: AudioBuffer): AudioBuffer {
  if (src.numberOfChannels === 2) return src;
  const out = ctx.createBuffer(2, src.length, src.sampleRate);
  const l = src.getChannelData(0);
  if (src.numberOfChannels === 1) {
    out.copyToChannel(l, 0);
    out.copyToChannel(l, 1);
    return out;
  }
  // ≥3 channels: take first 2.
  out.copyToChannel(l, 0);
  out.copyToChannel(src.getChannelData(1), 1);
  return out;
}
