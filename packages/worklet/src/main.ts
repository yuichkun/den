import { fetchWasmBytes } from "@denaudio/core";

/**
 * Cache key on `BaseAudioContext`: stores the realized WASM bytes once
 * `registerDenWorklet` has resolved (module installed + bytes fetched).
 *
 * `Symbol.for(...)` keeps the key stable across multiple bundled copies of
 * `@denaudio/worklet` — so two pinned versions still share the same cache
 * per context. The slot itself is a hidden property on the context, which
 * the W3C Web Audio spec does not mandate freezing (true in every 2026
 * browser); see `FALLBACK_CACHE` below for the freeze-tolerant escape
 * hatch.
 */
const CACHE_KEY = Symbol.for("den.worklet.cache");

/**
 * In-flight slot — carries the `Promise<void>` while a `registerDenWorklet`
 * call is mid-fetch. Concurrent callers (e.g., two effect classes both
 * issuing `Effect.register(ctx)` in parallel before either resolves) await
 * the same in-flight promise instead of duplicating the work. Cleared
 * once the realized `Cached` is written. (Implements §8 Fallback #4 from
 * the issue, eagerly rather than reactively.)
 */
const INFLIGHT_KEY = Symbol.for("den.worklet.inflight");

/**
 * Per-context flag recording that `audioWorklet.addModule` has succeeded
 * for the den processor. Persists across partial-register failures so a
 * retry (e.g., after fixing a bad `wasmUrl`) does NOT re-call
 * `addModule` — the processor file's `registerProcessor("den-processor",
 * …)` would throw `NotSupportedError` on a duplicate name and Firefox /
 * Safari are not specified to short-circuit duplicate addModule calls
 * (Chrome happens to, but that's implementation-defined). Without this
 * flag, a fetch-fails-but-addModule-succeeds first attempt would brick
 * every subsequent retry on those browsers.
 */
const MODULE_KEY = Symbol.for("den.worklet.module-added");

interface AugmentedContext extends BaseAudioContext {
  [CACHE_KEY]?: Cached;
  [INFLIGHT_KEY]?: Promise<void>;
  [MODULE_KEY]?: true;
}

interface Cached {
  bytes: ArrayBuffer;
}

// Freeze-tolerant fallback: if the host (or user code) called
// `Object.preventExtensions(ctx)` / `Object.freeze(ctx)`, the symbol-keyed
// hidden property write throws. We mirror all three slots into a
// module-private WeakMap so the cache still works. WeakMap entries are
// GCed with the context.
const FALLBACK_CACHE = new WeakMap<BaseAudioContext, Cached>();
const FALLBACK_INFLIGHT = new WeakMap<BaseAudioContext, Promise<void>>();
const FALLBACK_MODULE = new WeakMap<BaseAudioContext, true>();

function readCached(ctx: BaseAudioContext): Cached | undefined {
  const aug = ctx as AugmentedContext;
  return aug[CACHE_KEY] ?? FALLBACK_CACHE.get(ctx);
}

function writeCached(ctx: BaseAudioContext, value: Cached): void {
  const aug = ctx as AugmentedContext;
  try {
    aug[CACHE_KEY] = value;
  } catch {
    FALLBACK_CACHE.set(ctx, value);
  }
}

function readInflight(ctx: BaseAudioContext): Promise<void> | undefined {
  const aug = ctx as AugmentedContext;
  return aug[INFLIGHT_KEY] ?? FALLBACK_INFLIGHT.get(ctx);
}

function writeInflight(ctx: BaseAudioContext, p: Promise<void>): void {
  const aug = ctx as AugmentedContext;
  try {
    aug[INFLIGHT_KEY] = p;
  } catch {
    FALLBACK_INFLIGHT.set(ctx, p);
  }
}

function clearInflight(ctx: BaseAudioContext): void {
  const aug = ctx as AugmentedContext;
  try {
    delete aug[INFLIGHT_KEY];
  } catch {
    /* ignore */
  }
  FALLBACK_INFLIGHT.delete(ctx);
}

function readModuleAdded(ctx: BaseAudioContext): boolean {
  const aug = ctx as AugmentedContext;
  return aug[MODULE_KEY] === true || FALLBACK_MODULE.get(ctx) === true;
}

function writeModuleAdded(ctx: BaseAudioContext): void {
  const aug = ctx as AugmentedContext;
  try {
    aug[MODULE_KEY] = true;
  } catch {
    FALLBACK_MODULE.set(ctx, true);
  }
}

export interface RegisterOptions {
  /** Override the default WASM URL (e.g., for CDN delivery). */
  wasmUrl?: string;
  /** Override the worklet script URL (advanced — default shipped by package). */
  workletUrl?: string;
}

/**
 * Idempotently register the den AudioWorklet processor on the given context
 * and fetch the WASM bytes. Subsequent calls (including concurrent ones
 * before the first resolves) await the same work and resolve as soon as
 * the bytes are cached.
 *
 * Effect classes in `@denaudio/effects` call this in their own
 * `static async register(ctx)` and then construct the node synchronously
 * via [`getCachedWasmBytes`].
 */
export function registerDenWorklet(
  ctx: BaseAudioContext,
  options: RegisterOptions = {},
): Promise<void> {
  if (readCached(ctx)) return Promise.resolve();
  const inflight = readInflight(ctx);
  if (inflight) return inflight;
  const workletUrl = options.workletUrl ?? new URL("./processor.js", import.meta.url).href;
  // Capture each leg as its own promise so we can:
  // (a) await both via `Promise.all` to fail-fast on either rejection, AND
  // (b) await both via `Promise.allSettled` in `finally` so the
  //     in-flight lock isn't released while one leg is still pending.
  // Without (b), a fast `fetch` rejection while `addModule` is still
  // running would unlock the retry path immediately; the next register
  // call would start a SECOND concurrent `addModule` against the same
  // URL — Chrome short-circuits duplicate URLs but Firefox / Safari
  // are not specified to, and on those browsers the second worklet
  // evaluation re-runs `registerProcessor("den-processor", …)` which
  // throws `NotSupportedError`. Holding the lock until both legs
  // settle serializes any retry against the in-flight attempt.
  const fetchPromise = fetchWasmBytes(options.wasmUrl);
  const modulePromise = readModuleAdded(ctx)
    ? Promise.resolve()
    : ctx.audioWorklet.addModule(workletUrl).then(() => {
        // Persist BEFORE the outer Promise.all settles so a
        // fetch-failure landing AFTER addModule resolved still
        // records the partial progress for the retry path.
        writeModuleAdded(ctx);
      });
  const p = (async () => {
    try {
      const [bytes] = await Promise.all([fetchPromise, modulePromise]);
      writeCached(ctx, { bytes });
    } finally {
      // Wait for any still-pending leg to settle before clearing the
      // lock. `allSettled` is a no-op when both already settled (the
      // happy path) and avoids the concurrent-addModule race when one
      // rejected fast. The original error is preserved by the
      // try/finally semantics — `await` here doesn't swallow it.
      await Promise.allSettled([fetchPromise, modulePromise]);
      clearInflight(ctx);
    }
  })();
  writeInflight(ctx, p);
  return p;
}

/**
 * Synchronous accessor for the WASM bytes cached by [`registerDenWorklet`].
 * Effect class constructors call this to pass the bytes to the processor
 * via `processorOptions.__denWasmBytes`. Throws if `register` has not yet
 * resolved on the given context.
 */
export function getCachedWasmBytes(ctx: BaseAudioContext): ArrayBuffer {
  const cached = readCached(ctx);
  if (!cached) throw new Error("den: call await Effect.register(ctx) first");
  return cached.bytes;
}

/** Processor name registered by `./processor.ts` — keep in sync. */
export const DEN_PROCESSOR_NAME = "den-processor" as const;
