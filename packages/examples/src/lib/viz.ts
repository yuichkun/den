// Realtime visualizers for the catalog. Each call reads the latest
// analyser data and paints one frame. Pages drive these from a
// `requestAnimationFrame` loop while playing — no offline rendering,
// no rebuilt AudioContexts, no chained dispose lifecycles. Scratch
// buffers are cached at module scope and resized only when the
// analyser's `fftSize` / `frequencyBinCount` changes; safe because
// `main.ts` mounts at most one page at a time (the previous page's
// abort signal tears down its RAF loop before the next page starts
// its own), so there's never concurrent use of these caches.

// Typed `<ArrayBuffer>` (not the looser default `<ArrayBufferLike>`) so
// `analyser.getFloatTimeDomainData` accepts the buffer under DOM lib's
// strict ArrayBuffer-only signature.
let timeBuf: Float32Array<ArrayBuffer> | null = null;
let freqBuf: Float32Array<ArrayBuffer> | null = null;

/** Resize the canvas backing store to match its CSS box × devicePixelRatio. */
function ensureCanvasSize(canvas: HTMLCanvasElement): { w: number; h: number } {
  const dpr = globalThis.devicePixelRatio ?? 1;
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return { w, h };
}

/**
 * Draw the analyser's most recent ~5 ms as an oscilloscope-style
 * connected line trace, mono.
 *
 * Why ~5 ms (not the full `fftSize` window): at 48 kHz an analyser with
 * `fftSize=2048` covers ~42 ms, which is ~427 cycles of a 10 kHz sine.
 * Drawing 427 cycles into a 962-pixel canvas collapses the trace into
 * a solid band — technically correct but visually useless. Showing
 * only the last 256 samples (~5.3 ms at 48 kHz) keeps even 10 kHz
 * resolved to ~53 cycles ≈ 18 px / cycle while still showing 5+
 * cycles of a 1 kHz sine. Sliding-window (no zero-cross trigger) so
 * the trace ticker-tapes left-to-right under playback — that's a
 * fair trade for keeping the code one function and zero state.
 */
export function drawWaveform(canvas: HTMLCanvasElement, analyser: AnalyserNode): void {
  const { w, h } = ensureCanvasSize(canvas);
  const g = canvas.getContext("2d");
  if (!g) return;

  const VISIBLE_SAMPLES = Math.min(256, analyser.fftSize);
  // Reuse the scratch buffer across rAF ticks (60 fps × 8 KB
  // Float32Arrays adds up fast and was the explicit non-goal of this
  // catalog redesign — see issue #5 "no per-frame allocations").
  if (!timeBuf || timeBuf.length !== analyser.fftSize) {
    timeBuf = new Float32Array(analyser.fftSize);
  }
  analyser.getFloatTimeDomainData(timeBuf);
  const buf = timeBuf;
  const start = buf.length - VISIBLE_SAMPLES;

  g.fillStyle = "#0a0a0a";
  g.fillRect(0, 0, w, h);

  // Faint center line.
  g.strokeStyle = "#2a2a2a";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.stroke();

  g.strokeStyle = "#5b6cff";
  g.lineWidth = 1.5;
  g.beginPath();
  const denom = Math.max(1, VISIBLE_SAMPLES - 1);
  for (let i = 0; i < VISIBLE_SAMPLES; i++) {
    const x = (i / denom) * w;
    const s = buf[start + i] ?? 0;
    const y = h / 2 - s * (h / 2);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
}

/**
 * Draw the analyser's current frequency-domain data as a log-axis bar
 * spectrum (20 Hz on the left, Nyquist on the right). Magnitude in dBFS
 * mapped to a vertical bar inside [-100 dB, 0 dB].
 */
export function drawSpectrum(canvas: HTMLCanvasElement, analyser: AnalyserNode): void {
  const { w, h } = ensureCanvasSize(canvas);
  const g = canvas.getContext("2d");
  if (!g) return;

  const sr = analyser.context.sampleRate;
  const nBins = analyser.frequencyBinCount;
  if (!freqBuf || freqBuf.length !== nBins) {
    freqBuf = new Float32Array(nBins);
  }
  analyser.getFloatFrequencyData(freqBuf);
  const dbBuf = freqBuf;

  g.fillStyle = "#0a0a0a";
  g.fillRect(0, 0, w, h);

  // Per-pixel x → frequency bin via log-frequency mapping. Log axis matches
  // human pitch perception and matches the catalog's prior offline
  // spectrogram convention so users moving between effects feel at home.
  const fMin = 20;
  const fMax = sr / 2;
  const dbMin = -100;
  const dbMax = 0;

  g.fillStyle = "#5b6cff";
  for (let x = 0; x < w; x++) {
    const xn = x / Math.max(1, w - 1);
    const freq = fMin * Math.pow(fMax / fMin, xn);
    const bin = Math.min(nBins - 1, Math.max(0, Math.round((freq * nBins * 2) / sr)));
    const db = dbBuf[bin] ?? -Infinity;
    const norm = Math.max(0, Math.min(1, (db - dbMin) / (dbMax - dbMin)));
    const barH = norm * h;
    g.fillRect(x, h - barH, 1, barH);
  }
}
