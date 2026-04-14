/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runGoldenNull } from "@denaudio/test-utils/node";

interface DenCoreExports {
  memory: WebAssembly.Memory;
  den_alloc(n_bytes: number): number;
  den_dealloc(ptr: number, n_bytes: number): void;
  den_passthrough(
    l_in: number,
    r_in: number,
    l_out: number,
    r_out: number,
    n_samples: number,
  ): void;
}

const wasmBytes = readFileSync(resolve(import.meta.dirname, "../../core/dist/den_core.wasm"));
const mod = new WebAssembly.Module(wasmBytes);
const inst = new WebAssembly.Instance(mod);
const ex = inst.exports as unknown as DenCoreExports;

await runGoldenNull({
  effect: "passthrough",
  process: (stereoIn) => {
    const left = stereoIn[0]!;
    const right = stereoIn[1]!;
    const n = left.length;
    const bytes = n * 4;
    const lp = ex.den_alloc(bytes);
    const rp = ex.den_alloc(bytes);
    const lo = ex.den_alloc(bytes);
    const ro = ex.den_alloc(bytes);
    const heap = new Float32Array(ex.memory.buffer);
    heap.set(left, lp >> 2);
    heap.set(right, rp >> 2);
    ex.den_passthrough(lp, rp, lo, ro, n);
    const L = heap.slice(lo >> 2, (lo >> 2) + n);
    const R = heap.slice(ro >> 2, (ro >> 2) + n);
    ex.den_dealloc(lp, bytes);
    ex.den_dealloc(rp, bytes);
    ex.den_dealloc(lo, bytes);
    ex.den_dealloc(ro, bytes);
    return [L, R];
  },
});
