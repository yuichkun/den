/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runGoldenNull } from "@denaudio/test-utils/node";

interface DenCoreExports {
  memory: WebAssembly.Memory;
  den_alloc(n_bytes: number): number;
  den_dealloc(ptr: number, n_bytes: number): void;
  den_gain_size(): number;
  den_gain_init(state_ptr: number, sample_rate: number): void;
  den_gain_process(
    state_ptr: number,
    l_in: number,
    r_in: number,
    l_out: number,
    r_out: number,
    n: number,
    gain_values_ptr: number,
    n_gain_values: number,
  ): void;
}

const SR = 48000;
const wasmBytes = readFileSync(resolve(import.meta.dirname, "../../core/dist/den_core.wasm"));
const mod = new WebAssembly.Module(wasmBytes);

// `presetToGain` MUST match `scripts/gen-golden/effects.py:REGISTRY["gain"].presets`
// to the last digit. The dB→linear conversions here use the same Python
// arithmetic (10**(±6/20) → IEEE 754 double rounding) so the f64 written
// into the WASM heap and the f64 used in the scipy reference are bitwise
// identical at the API boundary. Any drift would surface as a Tier2 null
// failure.
const presetToGain: Record<string, number> = {
  unity: 1.0,
  minus_6db: 0.5011872336272722,
  plus_6db: 1.9952623149688795,
  silence: 0.0,
  mid_fade: 0.25,
};

function runGain(stereoIn: Float32Array[], preset: string): Float32Array[] {
  const target = presetToGain[preset];
  if (target === undefined) throw new Error(`unknown preset ${preset}`);

  // Fresh instance per call: keeps each preset's smoothing state
  // independent (the kernel ramps from `init=1.0` toward `target` over
  // the first ~20 ms, exactly like the scipy reference).
  const inst = new WebAssembly.Instance(mod);
  const ex = inst.exports as unknown as DenCoreExports;

  const left = stereoIn[0]!;
  const right = stereoIn[1]!;
  const n = left.length;
  const audioBytes = n * 4;
  const gainBytes = 4; // k-rate broadcast: a single f32 target value

  const lp = ex.den_alloc(audioBytes);
  const rp = ex.den_alloc(audioBytes);
  const lo = ex.den_alloc(audioBytes);
  const ro = ex.den_alloc(audioBytes);
  const gp = ex.den_alloc(gainBytes);
  const stateSize = ex.den_gain_size();
  const sp = ex.den_alloc(stateSize);

  const heap = new Float32Array(ex.memory.buffer);
  heap.set(left, lp >> 2);
  heap.set(right, rp >> 2);
  heap[gp >> 2] = target;

  ex.den_gain_init(sp, SR);
  ex.den_gain_process(sp, lp, rp, lo, ro, n, gp, 1);

  const L = heap.slice(lo >> 2, (lo >> 2) + n);
  const R = heap.slice(ro >> 2, (ro >> 2) + n);

  ex.den_dealloc(lp, audioBytes);
  ex.den_dealloc(rp, audioBytes);
  ex.den_dealloc(lo, audioBytes);
  ex.den_dealloc(ro, audioBytes);
  ex.den_dealloc(gp, gainBytes);
  ex.den_dealloc(sp, stateSize);

  return [L, R];
}

// Tight presets (-96 dBFS, parent epic D19 default).
await runGoldenNull({
  effect: "gain",
  presets: ["unity", "minus_6db", "silence", "mid_fade"],
  process: runGain,
});

// `plus_6db` peaks at ~+1.41 (chirp -3 dBFS × 1.995). At that magnitude
// the f32 smoothing state and the f64 scipy reference state diverge by
// ~1 ULP per sample during the 20 ms transient; the chirp's wide-band
// content samples the divergence at every frequency. Issue #5 §8
// Fallback #2 (b) anticipates exactly this case and prescribes -90 dBFS
// for presets that involve high-amplitude sub-sample transitions. Other
// `plus_6db` signals (sines, impulse, dc, silence) all clear -96 with
// margin; only the chirp is wide-band enough to be noisy here. We loosen
// for the whole `plus_6db` preset rather than per-(preset, signal) so
// the runner stays simple.
await runGoldenNull({
  effect: "gain",
  presets: ["plus_6db"],
  tolerance: -90,
  process: runGain,
});
