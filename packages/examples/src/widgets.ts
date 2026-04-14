import { CANONICAL } from "@denaudio/test-utils/signals";
import FFT from "fft.js";

type MakeEffectNode = (ctx: AudioContext) => Promise<AudioNode>;

const BUFFER_SR = 48000;

function makeSourceBuffer(
  ctx: AudioContext | OfflineAudioContext,
  signalName: string,
): AudioBuffer {
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
}

export function mountABPlayer(
  container: HTMLElement,
  ctx: AudioContext,
  makeEffectNode: MakeEffectNode,
): ABPlayerHandle {
  container.innerHTML = `
    <h3>A / B player</h3>
    <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap;">
      <label>Signal <select class="sig">
        ${Object.keys(CANONICAL)
          .map((n) => `<option value="${n}">${n}</option>`)
          .join("")}
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
    src.buffer = makeSourceBuffer(ctx, sigSel.value);
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

  return {
    async getLastRendered(): Promise<AudioBuffer> {
      const sigBuf = makeSourceBuffer(ctx, sigSel.value);
      const off = new OfflineAudioContext({
        numberOfChannels: 2,
        length: sigBuf.length,
        sampleRate: BUFFER_SR,
      });
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
  container.innerHTML = `<h3>Waveform (L + R)</h3><canvas></canvas>`;
  const canvas = container.querySelector<HTMLCanvasElement>("canvas")!;
  const dpr = globalThis.devicePixelRatio ?? 1;
  const w = (canvas.width = canvas.clientWidth * dpr);
  const h = (canvas.height = canvas.clientHeight * dpr);
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);
  for (let ch = 0; ch < Math.min(2, buffer.numberOfChannels); ch++) {
    const data = buffer.getChannelData(ch);
    const bins = w;
    const samplesPerBin = Math.max(1, Math.floor(data.length / bins));
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
      const yMin = ((1 - min) * h) / 2;
      const yMax = ((1 - max) * h) / 2;
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
  container.innerHTML = `<h3>Spectrogram (L, log-freq)</h3><canvas></canvas>`;
  const canvas = container.querySelector<HTMLCanvasElement>("canvas")!;
  const dpr = globalThis.devicePixelRatio ?? 1;
  const w = (canvas.width = canvas.clientWidth * dpr);
  const h = (canvas.height = canvas.clientHeight * dpr);
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, w, h);

  const mono = buffer.getChannelData(0);
  const frames = Math.max(1, Math.floor((mono.length - SPEC_FFT) / SPEC_HOP));
  const fft = new (FFT as unknown as FftConstructor)(SPEC_FFT);
  const outSpec: number[] = Array.from({ length: SPEC_FFT * 2 }, () => 0);
  const window = new Float32Array(SPEC_FFT);
  for (let i = 0; i < SPEC_FFT; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (SPEC_FFT - 1)));
  }

  const mags = new Float32Array(SPEC_FFT / 2);
  const imageData = g.createImageData(frames, SPEC_FFT / 2);
  const data = imageData.data;
  const input: number[] = Array.from({ length: SPEC_FFT }, () => 0);
  for (let f = 0; f < frames; f++) {
    const base = f * SPEC_HOP;
    for (let i = 0; i < SPEC_FFT; i++) {
      input[i] = (mono[base + i] ?? 0) * (window[i] ?? 0);
    }
    fft.realTransform(outSpec, input);
    fft.completeSpectrum(outSpec);
    for (let k = 0; k < SPEC_FFT / 2; k++) {
      const re = outSpec[2 * k] ?? 0;
      const im = outSpec[2 * k + 1] ?? 0;
      mags[k] = Math.sqrt(re * re + im * im);
    }
    for (let k = 0; k < SPEC_FFT / 2; k++) {
      const mag = mags[k] ?? 0;
      const db = 20 * Math.log10(mag + 1e-9);
      const norm = Math.max(0, Math.min(1, (db + 96) / 96));
      const row = SPEC_FFT / 2 - 1 - k;
      const pxIdx = (row * frames + f) * 4;
      const c = Math.floor(norm * 255);
      data[pxIdx] = c;
      data[pxIdx + 1] = c;
      data[pxIdx + 2] = Math.floor(norm * 180 + 60);
      data[pxIdx + 3] = 255;
    }
  }
  const bmp = g.createImageData(frames, SPEC_FFT / 2);
  bmp.data.set(data);
  g.putImageData(bmp, 0, 0);
  // Scale to canvas size.
  g.imageSmoothingEnabled = false;
  g.drawImage(canvas, 0, 0, frames, SPEC_FFT / 2, 0, 0, w, h);
}
