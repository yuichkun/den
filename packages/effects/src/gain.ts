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
 * const gain = new Gain(ctx, { gain: 0.5 }); // initial -6 dB
 * source.connect(gain).connect(ctx.destination);
 *
 * // AudioParam automation works as-is.
 * gain.gain.setValueAtTime(1.0, ctx.currentTime);
 * gain.gain.linearRampToValueAtTime(0.0, ctx.currentTime + 2.0);
 * ```
 *
 * Because the smoother is initialized to unity, constructing
 * `new Gain(ctx, { gain: 0.5 })` produces a 20 ms unity-to-half fade-in.
 * To skip the ramp, omit `gain` (defaults to 1.0) and call
 * `gain.gain.setValueAtTime(target, 0)` explicitly.
 */
export class Gain extends AudioWorkletNode {
  readonly gain: AudioParam;

  /**
   * Stereo in, stereo out. If the upstream source is mono (single-channel
   * `AudioBuffer` etc.), the worklet duplicates the L channel into R for
   * processing — output is always stereo, both channels carry the same
   * gain-applied signal.
   */
  constructor(ctx: BaseAudioContext, options: GainOptions = {}) {
    const bytes = getCachedWasmBytes(ctx);
    // Conditional spread instead of `parameterData: ... | undefined`: with
    // `exactOptionalPropertyTypes` the field type rejects an explicit
    // `undefined`. Omitting the key entirely is the spec-correct way to
    // "use the descriptor's defaultValue".
    super(ctx, DEN_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      ...(options.gain !== undefined ? { parameterData: { gain: options.gain } } : {}),
      processorOptions: { __denKernelId: "gain", __denWasmBytes: bytes },
    });
    const p = this.parameters.get("gain");
    if (!p) throw new Error("den: AudioParam 'gain' not registered");
    this.gain = p;
  }

  /**
   * Free WASM-side state and I/O buffers. AudioWorklet has no JS-side
   * destructor hook, so users that create-and-destroy many Gain nodes
   * (e.g., per-track UI) MUST call `dispose()` to avoid leaking a few
   * hundred bytes per node into the WASM linear memory. After dispose the
   * node MUST NOT be re-used; disconnect upstream/downstream first if not
   * already wired through this method.
   */
  dispose(): void {
    this.port.postMessage({ __denCmd: "destroy" });
    this.disconnect();
  }

  /** Idempotent: loads WASM and installs the worklet module on `ctx`. */
  static async register(ctx: BaseAudioContext, options: RegisterOptions = {}): Promise<void> {
    await registerDenWorklet(ctx, options);
  }
}
