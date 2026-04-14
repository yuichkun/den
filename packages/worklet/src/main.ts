import { fetchWasmBytes } from "@denaudio/core";

/**
 * Cache key on `BaseAudioContext`: stores the realized WASM bytes once
 * `registerDenWorklet` has resolved (module installed + bytes fetched).
 *
 * `Symbol.for(...)` keeps the key stable across multiple bundled copies of
 * `@denaudio/worklet` AT THE SAME MAJOR VERSION — different patch / minor
 * builds of the current shape interoperate transparently (both write
 * `{ bytes: ArrayBuffer }`), so a transitive-dep duplicate doesn't
 * double-register the processor. Cross-major compat (e.g. a hypothetical
 * future v2 alongside this v1) is NOT a goal here: shape validation in
 * `readCached` rejects unknown shapes silently and the regular register
 * path runs again. On browsers that don't dedupe duplicate
 * `registerProcessor("den-processor", …)` (Firefox / Safari are not
 * specified to), that re-register will fail. Pre-1.0 there is no v2 to
 * worry about; if a future v2 lands it must include explicit migration
 * (e.g. either await any legacy promise it finds in the slot, or pick a
 * fresh symbol name for its own shape). The slot itself is a hidden
 * property on the context, which the W3C Web Audio spec does not mandate
 * freezing (true in every 2026 browser); see `FALLBACK_CACHE` below for
 * the freeze-tolerant escape hatch.
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
 * Per-context record of which worklet `URL` was successfully added via
 * `audioWorklet.addModule`. Persists across partial-register failures so
 * a retry with the SAME url (e.g., after fixing a bad `wasmUrl`) skips
 * addModule — the processor file's `registerProcessor("den-processor",
 * …)` would throw `NotSupportedError` on a duplicate name and Firefox /
 * Safari are not specified to short-circuit duplicate addModule calls
 * (Chrome happens to, but that's implementation-defined).
 *
 * URL-aware (not just `true`) so that a retry with a DIFFERENT workletUrl
 * correctly re-attempts addModule. Scenario: the caller first passed a
 * loadable-but-wrong url (one that fetched OK but didn't register
 * "den-processor", or registered a different implementation) — with a
 * plain boolean flag the retry would silently skip addModule, trusting
 * the wrong module that was loaded. With the url recorded, a mismatched
 * retry runs addModule again (which will fail cleanly with
 * `NotSupportedError` if the old url already latched some processor
 * onto the ctx, surfacing the problem instead of hiding it — the only
 * real recovery in that case is a fresh AudioContext).
 */
const MODULE_KEY = Symbol.for("den.worklet.module-added");

interface ModuleAdded {
  url: string;
}

interface AugmentedContext extends BaseAudioContext {
  [CACHE_KEY]?: Cached;
  [INFLIGHT_KEY]?: Promise<void>;
  [MODULE_KEY]?: ModuleAdded;
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
const FALLBACK_MODULE = new WeakMap<BaseAudioContext, ModuleAdded>();

function readCached(ctx: BaseAudioContext): Cached | undefined {
  // Shape-validate: `Symbol.for("den.worklet.cache")` is global across
  // bundled copies of `@denaudio/worklet`, and an older Sub B build
  // stored a `Promise<{ bytes, workletModuleAdded }>` under the same
  // key. If we ever load alongside such a build, treating the Promise
  // as truthy would short-circuit `registerDenWorklet` here, and
  // `getCachedWasmBytes` would later read `cached.bytes` as undefined,
  // making `instantiateSync(undefined)` throw inside the worklet.
  // Require an actual `ArrayBuffer` in the `bytes` slot before trusting
  // the cache; anything else is treated as "not cached" and the
  // regular register path overwrites the slot with our shape.
  //
  // Check the symbol slot AND the WeakMap fallback INDEPENDENTLY (not
  // via `??`): if the symbol slot holds an incompatible value AND the
  // ctx is frozen (so `writeCached` could only update the WeakMap
  // fallback), `??` would short-circuit on the truthy-but-incompatible
  // symbol value and never read the valid WeakMap entry — leaving the
  // ctx permanently mis-detected as "not registered".
  const aug = ctx as AugmentedContext;
  const symVal = aug[CACHE_KEY];
  if (symVal && symVal.bytes instanceof ArrayBuffer) return symVal;
  const fallback = FALLBACK_CACHE.get(ctx);
  if (fallback && fallback.bytes instanceof ArrayBuffer) return fallback;
  return undefined;
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

/**
 * URL-aware read: returns true only if `addModule(url)` was previously
 * recorded for this ctx with the same `url`. Mismatched url → false
 * (retry should attempt addModule, which will succeed if the ctx is
 * still clean OR surface a clear `NotSupportedError` if some prior url
 * latched a processor onto it).
 */
function readModuleAdded(ctx: BaseAudioContext, url: string): boolean {
  const aug = ctx as AugmentedContext;
  const info = aug[MODULE_KEY] ?? FALLBACK_MODULE.get(ctx);
  return info?.url === url;
}

function writeModuleAdded(ctx: BaseAudioContext, url: string): void {
  const info: ModuleAdded = { url };
  const aug = ctx as AugmentedContext;
  try {
    aug[MODULE_KEY] = info;
  } catch {
    FALLBACK_MODULE.set(ctx, info);
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
  const modulePromise = readModuleAdded(ctx, workletUrl)
    ? Promise.resolve()
    : ctx.audioWorklet.addModule(workletUrl).then(() => {
        // Persist BEFORE the outer Promise.all settles so a
        // fetch-failure landing AFTER addModule resolved still
        // records the partial progress for the retry path. Records
        // the specific url so a retry with a CORRECTED url (after
        // a typo / wrong path on the first attempt) still attempts
        // addModule instead of trusting the wrong module.
        writeModuleAdded(ctx, workletUrl);
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
  // `readCached` now shape-validates (returns `undefined` for any value
  // that isn't `{ bytes: ArrayBuffer }`), so a stale Sub B-style
  // `Promise` in the slot triggers the same "call register first" error
  // a fresh ctx would, instead of silently returning `undefined`.
  const cached = readCached(ctx);
  if (!cached) throw new Error("den: call await Effect.register(ctx) first");
  return cached.bytes;
}

/** Processor name registered by `./processor.ts` — keep in sync. */
export const DEN_PROCESSOR_NAME = "den-processor" as const;
