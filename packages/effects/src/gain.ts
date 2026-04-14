import {
  DEN_PROCESSOR_NAME,
  getCachedWasmBytes,
  registerDenWorklet,
  type RegisterOptions,
} from "@denaudio/worklet";

/**
 * Construction options for the `Gain` effect. Note: this interface does
 * NOT extend `RegisterOptions`. URL overrides (`wasmUrl` / `workletUrl`)
 * apply only to the async `Gain.register(ctx, opts)` phase; passing them
 * to the sync constructor would silently no-op, which is a footgun. Keep
 * the two phases' options separate.
 */
export interface GainOptions {
  /** Initial linear gain. Default 1.0. Clamped to [0, 10] by the AudioParam descriptor. */
  gain?: number;
}

/**
 * Linear per-channel gain with 1-pole exponential smoothing (20 ms tau).
 *
 * ```ts
 * import { Gain } from "@denaudio/effects";
 *
 * const ctx = new AudioContext();
 * await Gain.register(ctx);                  // once per context
 * const gain = new Gain(ctx, { gain: 0.5 }); // starts at -6 dB, no transient
 * source.connect(gain).connect(ctx.destination);
 *
 * // AudioParam automation smooths via the kernel's 1-pole as expected:
 * gain.gain.setValueAtTime(1.0, ctx.currentTime);
 * gain.gain.linearRampToValueAtTime(0.0, ctx.currentTime + 2.0);
 * ```
 *
 * The constructor seeds the kernel's smoothed state with `options.gain`
 * (1.0 if omitted), so the FIRST quantum already plays at the
 * user-requested gain — no audible "unity → target" decay on startup.
 * Subsequent automation (`setValueAtTime`, `linearRampToValueAtTime`,
 * etc.) still smooths via the per-sample 1-pole the same way.
 */
export class Gain extends AudioWorkletNode {
  readonly gain: AudioParam;

  /** Idempotency guard for `dispose()`; second and later calls no-op. */
  #disposed = false;

  /**
   * Stereo in, stereo out. If the upstream source is mono (single-channel
   * `AudioBuffer` etc.), the worklet duplicates the L channel into R for
   * processing — output is always stereo, both channels carry the same
   * gain-applied signal.
   */
  constructor(ctx: BaseAudioContext, options: GainOptions = {}) {
    const bytes = getCachedWasmBytes(ctx);
    // Always set parameterData AND processorOptions.__denInitialGain to
    // the same value so the AudioParam target and the kernel's smoother
    // seed agree from sample 0 — no audible "unity → target" decay on
    // startup. Default = 1.0 (matches the descriptor's defaultValue).
    const initialGain = options.gain ?? 1.0;
    super(ctx, DEN_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: { gain: initialGain },
      processorOptions: {
        __denKernelId: "gain",
        __denWasmBytes: bytes,
        __denInitialGain: initialGain,
      },
    });
    const p = this.parameters.get("gain");
    if (!p) throw new Error("den: AudioParam 'gain' not registered");
    this.gain = p;
  }

  /**
   * Free WASM-side state + I/O buffers and disconnect the node from
   * the audio graph.
   *
   * **WARNING — disconnects ALL connections to/from this node.** Calling
   * `dispose()` on a wired node (e.g., `src.connect(gain).connect(dest)`)
   * silences the entire chain immediately: both the upstream→gain edge
   * and the gain→downstream edge are dropped synchronously on the main
   * thread. The destroy message is then posted to the worklet to free
   * the WASM-side state on the next quantum boundary. After dispose the
   * node MUST NOT be re-used.
   *
   * Idempotent — second and later calls no-op.
   *
   * Required for any UI that creates many short-lived Gain nodes
   * (per-track effect chains, dynamic patching). Without it each
   * disposed node leaks a few hundred bytes of WASM linear memory —
   * AudioWorklet has no JS-side destructor hook.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.port.postMessage({ __denCmd: "destroy" });
    this.disconnect();
  }

  /** Idempotent: loads WASM and installs the worklet module on `ctx`. */
  static async register(ctx: BaseAudioContext, options: RegisterOptions = {}): Promise<void> {
    await registerDenWorklet(ctx, options);
  }
}
