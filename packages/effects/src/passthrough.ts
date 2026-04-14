import {
  DEN_PROCESSOR_NAME,
  getCachedWasmBytes,
  registerDenWorklet,
  type RegisterOptions,
} from "@denaudio/worklet";

/**
 * Stereo passthrough — output equals input. `@internal`: this class exists
 * to validate the WASM build / worklet bridge / null-test wiring without
 * DSP getting in the way. Real users want one of the actual effects (e.g.
 * `Gain`); this stays in the public surface only because the test harness
 * imports it and Sub E's add-effect template references it as the minimum
 * canonical effect shape.
 *
 * Usage mirrors every other `@denaudio/effects` class:
 * ```ts
 * await Passthrough.register(ctx);
 * const node = new Passthrough(ctx);
 * source.connect(node).connect(ctx.destination);
 * // when done:
 * node.dispose();
 * ```
 */
export class Passthrough extends AudioWorkletNode {
  /** Idempotency guard for `dispose()`; second and later calls no-op. */
  #disposed = false;

  constructor(ctx: BaseAudioContext) {
    const bytes = getCachedWasmBytes(ctx);
    super(ctx, DEN_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { __denKernelId: "passthrough", __denWasmBytes: bytes },
    });
  }

  /**
   * Free WASM-side I/O buffers and disconnect the node from the audio
   * graph. **WARNING — disconnects ALL connections to/from this node**
   * (matching `Gain.dispose`); see `Gain` TSDoc for full semantics.
   * Idempotent. After dispose the node MUST NOT be re-used.
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
