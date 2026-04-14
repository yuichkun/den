// AudioWorkletGlobalScope: no DOM, no fetch (used only if necessary), no ESM imports
// at runtime. This file is built as a classic IIFE; types are stripped.
// All needed WASM-loading logic is inlined here.

/// <reference types="audioworklet" />

// --- Inlined instantiateSync (copy of @denaudio/core's version; no runtime import) ---
function instantiateSync(bytes: ArrayBuffer): WebAssembly.Instance {
  const mod = new WebAssembly.Module(bytes);
  return new WebAssembly.Instance(mod);
}

type Kernel = "passthrough"; // Sub D adds: | "gain"

/**
 * Dispatch a kernel call. In this stub issue, only "passthrough" is supported.
 * Sub D adds the Gain kernel and param handling.
 */
function callKernel(
  kernelId: Kernel,
  instance: WebAssembly.Instance,
  l_in: number,
  r_in: number,
  l_out: number,
  r_out: number,
  n: number,
): void {
  const ex = instance.exports as any;
  switch (kernelId) {
    case "passthrough":
      ex.den_passthrough(l_in, r_in, l_out, r_out, n);
      return;
  }
}

class DenProcessor extends AudioWorkletProcessor {
  private instance!: WebAssembly.Instance;
  private kernelId!: Kernel;

  // Pre-allocated WASM heap pointers. Freed only on explicit `dispose()`
  // via `{__denCmd: "destroy"}` port message (see Sub D §6.2).
  private l_in_ptr = 0;
  private r_in_ptr = 0;
  private l_out_ptr = 0;
  private r_out_ptr = 0;
  private heap_f32!: Float32Array;
  protected alive = true;

  // Render quantum (always 128 in Web Audio).
  private static readonly QUANTUM = 128;
  private static readonly BYTES_PER_BUFFER = DenProcessor.QUANTUM * 4;

  static get parameterDescriptors(): AudioParamDescriptor[] {
    // Sub D adds params per-kernel.
    return [];
  }

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const po = options.processorOptions as {
      __denWasmBytes: ArrayBuffer;
      __denKernelId: Kernel;
    };
    this.instance = instantiateSync(po.__denWasmBytes);
    this.kernelId = po.__denKernelId;

    const ex = this.instance.exports as any;
    const bytes = DenProcessor.BYTES_PER_BUFFER;
    this.l_in_ptr = ex.den_alloc(bytes);
    this.r_in_ptr = ex.den_alloc(bytes);
    this.l_out_ptr = ex.den_alloc(bytes);
    this.r_out_ptr = ex.den_alloc(bytes);
    this.heap_f32 = new Float32Array((ex.memory as WebAssembly.Memory).buffer);
  }

  /**
   * Free WASM-side I/O buffer allocations. Called from a subclass's
   * `port.onmessage` handler when a `{__denCmd: "destroy"}` message arrives
   * (Sub D's `Gain.dispose()` is the canonical caller). Sizes MUST match the
   * `den_alloc` sizes exactly (`Layout` mismatch silently no-ops the dealloc).
   * Idempotent: safe to call multiple times.
   */
  protected disposeIoBuffers(): void {
    const ex = this.instance.exports as any;
    const bytes = DenProcessor.BYTES_PER_BUFFER;
    if (this.l_in_ptr) {
      ex.den_dealloc(this.l_in_ptr, bytes);
      this.l_in_ptr = 0;
    }
    if (this.r_in_ptr) {
      ex.den_dealloc(this.r_in_ptr, bytes);
      this.r_in_ptr = 0;
    }
    if (this.l_out_ptr) {
      ex.den_dealloc(this.l_out_ptr, bytes);
      this.l_out_ptr = 0;
    }
    if (this.r_out_ptr) {
      ex.den_dealloc(this.r_out_ptr, bytes);
      this.r_out_ptr = 0;
    }
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const input = inputs[0] ?? [];
    const output = outputs[0];
    if (!output?.[0]) {
      return true;
    }

    // Web Audio hands us separate L/R Float32Arrays per channel.
    // Important: when no upstream source is connected, Web Audio passes an
    // EMPTY ARRAY (length 0), NOT undefined. Check `.length` not truthiness.
    // (See WebAudio API issue #2177; Firefox bug 1629478.)
    const l_src = (input[0]?.length ?? 0) > 0 ? input[0]! : new Float32Array(DenProcessor.QUANTUM);
    const r_src = (input[1]?.length ?? 0) > 0 ? input[1]! : l_src;

    const n = DenProcessor.QUANTUM;
    const l_in_f32 = this.l_in_ptr >> 2;
    const r_in_f32 = this.r_in_ptr >> 2;
    const l_out_f32 = this.l_out_ptr >> 2;
    const r_out_f32 = this.r_out_ptr >> 2;

    // Re-take a view in case memory grew (grow() invalidates the old view).
    if (this.heap_f32.buffer !== (this.instance.exports.memory as WebAssembly.Memory).buffer) {
      this.heap_f32 = new Float32Array((this.instance.exports.memory as WebAssembly.Memory).buffer);
    }

    this.heap_f32.set(l_src, l_in_f32);
    this.heap_f32.set(r_src, r_in_f32);

    callKernel(
      this.kernelId,
      this.instance,
      this.l_in_ptr,
      this.r_in_ptr,
      this.l_out_ptr,
      this.r_out_ptr,
      n,
    );

    output[0].set(this.heap_f32.subarray(l_out_f32, l_out_f32 + n));
    if (output[1]) output[1].set(this.heap_f32.subarray(r_out_f32, r_out_f32 + n));

    return true;
  }
}

registerProcessor("den-processor", DenProcessor);
