import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const wasm = await readFile(resolve("packages/core/dist/den_core.wasm"));
const { instance } = await WebAssembly.instantiate(wasm);
const ex = instance.exports;

const N = 128;
const bytes = N * 4;
const lp = ex.den_alloc(bytes),
  rp = ex.den_alloc(bytes),
  lo = ex.den_alloc(bytes),
  ro = ex.den_alloc(bytes);
const view = new Float32Array(ex.memory.buffer);
for (let i = 0; i < N; i++) {
  view[(lp >> 2) + i] = i / N;
  view[(rp >> 2) + i] = -i / N;
}
ex.den_passthrough(lp, rp, lo, ro, N);
for (let i = 0; i < N; i++) {
  if (view[(lo >> 2) + i] !== i / N) throw new Error(`L mismatch at ${i}`);
  if (view[(ro >> 2) + i] !== -i / N) throw new Error(`R mismatch at ${i}`);
}
console.log("✓ smoke-node OK");
