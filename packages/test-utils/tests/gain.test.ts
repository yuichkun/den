/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runGoldenNull } from "@denaudio/test-utils/node";

interface DenCoreExports {
  memory: WebAssembly.Memory;
  den_alloc(n_bytes: number): number;
  den_dealloc(ptr: number, n_bytes: number): void;
  den_gain_size(): number;
  den_gain_init(state_ptr: number, sample_rate: number, initial: number): void;
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

  // initial = 1.0 to match the scipy reference (which fixes `init=1.0`
  // in `gain_process`). The new `__denInitialGain` processorOption in
  // the worklet path forwards the user-facing `gain` option, but the
  // goldens themselves are generated with a unity initial state so we
  // use 1.0 here too.
  ex.den_gain_init(sp, SR, 1.0);
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

// Single tolerance for all 5 presets — the kernel keeps smoothing state
// in f64, matching the scipy reference bit-for-bit on the trajectory,
// so even at +6 dB peak (~+1.41 from the chirp) the diff stays below
// the parent epic's D19 default of -96 dBFS by > 30 dB. An earlier f32
// kernel needed a per-preset -90 override (Issue §8 Fallback #2 (b))
// because steady-state f32 multiplication noise integrated over 2 s
// crossed -96 at unity-amplitude × +6 dB; f64 fixes that without
// per-preset configs and is the canonical pattern for any future
// effect with smoothed feedback or recursive coefficients.
await runGoldenNull({
  effect: "gain",
  presets: Object.keys(presetToGain),
  process: runGain,
});
