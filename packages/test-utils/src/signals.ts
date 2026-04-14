export const SR = 48000;
export const DUR = 2.0;
export const N = (SR * DUR) | 0;

// Log chirp f0 → f1 over durSec, cosine form matching scipy.signal.chirp
// (scipy returns cos(phase + phi), phi defaults to 0). At t=0 we emit
// `cos(0) * peak = peak`, NOT 0 — matching the Python golden.
export function chirpLog(sr = SR, durSec = DUR): Float32Array {
  const n = (sr * durSec) | 0;
  const out = new Float32Array(n);
  const f0 = 20,
    f1 = 20000;
  const beta = durSec / Math.log(f1 / f0);
  const peak = Math.pow(10, -3 / 20);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const phase = 2 * Math.PI * beta * f0 * (Math.pow(f1 / f0, t / durSec) - 1);
    out[i] = Math.cos(phase) * peak;
  }
  return out;
}

export function sine(freq: number, durSec = 0.5, sr = SR): Float32Array {
  const n = (sr * durSec) | 0;
  const out = new Float32Array(n);
  const peak = Math.pow(10, -6 / 20);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr) * peak;
  return out;
}

export function impulse(n = N): Float32Array {
  const out = new Float32Array(n);
  out[0] = 1.0;
  return out;
}

export function dc(level = 0.5, n = N): Float32Array {
  return new Float32Array(n).fill(level);
}

export function silence(n = N): Float32Array {
  return new Float32Array(n);
}

// Pink noise is intentionally omitted from the TS side. Tier3a (this module's
// consumer in the browser) uses chirp + sine + impulse only; Tier2 uses the
// full Python set including pink (parity is not required — see issue #4 §6.4).
export const CANONICAL: Record<string, () => Float32Array> = {
  chirp: () => chirpLog(),
  sine_1k: () => sine(1000, 1.0),
  sine_5k: () => sine(5000, 1.0),
  sine_10k: () => sine(10000, 1.0),
  impulse: () => impulse(),
  dc_half: () => dc(0.5),
  silence: () => silence(),
};
