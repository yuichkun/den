// @denaudio/core — low-level WASM loader and typed exports.
//
// Consumers typically do NOT import from @denaudio/core directly. Use @denaudio/effects
// for a ready-to-use effect API. This package is for library authors and
// advanced users composing custom AudioWorklet processors.

/**
 * Returns the URL of the shipped WASM binary, resolved relative to the
 * compiled @denaudio/core dist/ directory.
 *
 * Why this pattern (not `?url` import): Vite's library mode unreliably handles
 * `?url` queries (vitejs/vite#3295). The `new URL(rel, import.meta.url)` pattern
 * works in every modern bundler (Vite, webpack 5, Rollup, esbuild, native ESM).
 * Build script (scripts/build-wasm.mjs) copies den_core.wasm next to index.js
 * inside dist/, so the relative URL resolves correctly at consumer runtime.
 */
export function getDefaultWasmUrl(): string {
  return new URL("./den_core.wasm", import.meta.url).href;
}

/**
 * Fetch WASM bytes from the given URL (or the package-shipped default).
 * Main thread only — AudioWorkletGlobalScope must receive bytes via
 * processorOptions (see @denaudio/worklet).
 */
export async function fetchWasmBytes(url?: string): Promise<ArrayBuffer> {
  const resolved = url ?? getDefaultWasmUrl();
  const res = await fetch(resolved);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`den: WASM not found at ${resolved}`);
    }
    throw new Error(`den: failed to fetch WASM at ${resolved} (${res.status})`);
  }
  return await res.arrayBuffer();
}

/** Shape of exports emitted by crates/den-core/src/lib.rs. */
export interface DenCoreExports {
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
  // Sub D adds: den_gain_process(...)
}

/** Instantiate the WASM module with no imports (pure-compute kernel). */
export async function instantiate(
  bytes: ArrayBuffer,
): Promise<WebAssembly.Instance & { exports: DenCoreExports }> {
  const mod = await WebAssembly.compile(bytes);
  const inst = await WebAssembly.instantiate(mod);
  return inst as unknown as WebAssembly.Instance & { exports: DenCoreExports };
}

/** Synchronous instantiation, for use inside AudioWorkletGlobalScope. */
export function instantiateSync(
  bytes: ArrayBuffer,
): WebAssembly.Instance & { exports: DenCoreExports } {
  const mod = new WebAssembly.Module(bytes);
  const inst = new WebAssembly.Instance(mod);
  return inst as unknown as WebAssembly.Instance & { exports: DenCoreExports };
}
