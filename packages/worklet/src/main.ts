import { fetchWasmBytes } from "@denaudio/core";

/**
 * Cache key on BaseAudioContext: stores fetched WASM bytes + flag that
 * audioWorklet.addModule has been called. Sub D refactors this to a
 * cleaner public API (`registerDenWorklet → Promise<void>` + a separate
 * `getCachedWasmBytes(ctx)` synchronous accessor); this Sub B shape is
 * transitional. Symbol name is shared across both implementations.
 */
const CACHE_KEY = Symbol.for("den.worklet.cache");

interface AugmentedContext extends BaseAudioContext {
  [CACHE_KEY]?: Promise<WasmReady>;
}

/**
 * Forward-compat fallback per issue #3 §3 Decision row 43: the W3C Web Audio
 * spec does not mandate freezing `BaseAudioContext`, so the `Symbol.for`
 * hidden-property write succeeds in every 2026 browser, but a host (or user
 * code) may `Object.preventExtensions(ctx)` / `Object.freeze(ctx)` and break
 * the property write. The WeakMap is module-private so its entries are GCed
 * with the context.
 */
const FALLBACK_CACHE = new WeakMap<BaseAudioContext, Promise<WasmReady>>();

function readCache(ctx: BaseAudioContext): Promise<WasmReady> | undefined {
  const aug = ctx as AugmentedContext;
  return aug[CACHE_KEY] ?? FALLBACK_CACHE.get(ctx);
}

function writeCache(ctx: BaseAudioContext, p: Promise<WasmReady>): void {
  const aug = ctx as AugmentedContext;
  try {
    aug[CACHE_KEY] = p;
  } catch {
    // ctx is non-extensible / frozen — fall back to the module-private WeakMap.
    FALLBACK_CACHE.set(ctx, p);
  }
}

export interface WasmReady {
  bytes: ArrayBuffer;
  workletModuleAdded: true;
}

export interface RegisterOptions {
  /** Override the default WASM URL (for CDN delivery). */
  wasmUrl?: string;
  /** Override the worklet script URL (advanced — default shipped by package). */
  workletUrl?: string;
}

/**
 * Idempotently register the den AudioWorklet processor on the given context
 * and fetch the WASM bytes. Returns the shared promise.
 *
 * Every effect class in @denaudio/effects calls this in its own `register(ctx)`
 * static method.
 */
export function registerDenWorklet(
  ctx: BaseAudioContext,
  options: RegisterOptions = {},
): Promise<WasmReady> {
  const cached = readCache(ctx);
  if (cached) return cached;
  const workletUrl = options.workletUrl ?? new URL("./processor.js", import.meta.url).href;
  const p = (async () => {
    const [bytes] = await Promise.all([
      fetchWasmBytes(options.wasmUrl),
      ctx.audioWorklet.addModule(workletUrl),
    ]);
    return { bytes, workletModuleAdded: true as const };
  })();
  writeCache(ctx, p);
  return p;
}

/** Processor name registered by ./processor.ts — keep in sync. */
export const DEN_PROCESSOR_NAME = "den-processor" as const;

/**
 * Construct an AudioWorkletNode backed by the den processor, passing the
 * WASM bytes through processorOptions so the worklet can instantiate sync.
 *
 * Used internally by @denaudio/effects. Exposed for advanced users.
 */
export async function createDenNode(
  ctx: BaseAudioContext,
  kernelId: string,
  nodeOptions: AudioWorkletNodeOptions,
  registerOpts: RegisterOptions = {},
): Promise<AudioWorkletNode> {
  const { bytes } = await registerDenWorklet(ctx, registerOpts);
  const processorOptions = {
    ...nodeOptions.processorOptions,
    __denKernelId: kernelId,
    __denWasmBytes: bytes,
  };
  return new AudioWorkletNode(ctx, DEN_PROCESSOR_NAME, {
    ...nodeOptions,
    processorOptions,
  });
}
