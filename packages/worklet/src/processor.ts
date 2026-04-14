// AudioWorkletGlobalScope: no DOM, no fetch (used only if necessary), no ESM imports
// at runtime. This file is built as a classic IIFE; types are stripped.
// All needed WASM-loading logic is inlined here.

/// <reference types="audioworklet" />

// `AudioParamDescriptor` is part of the Web Audio AudioWorklet spec
// (https://webaudio.github.io/web-audio-api/#dom-audioparamdescriptor) but
// is not declared in `@types/audioworklet@0.0.97` (the latest as of writing
// — see microsoft/TypeScript-DOM-Lib-Generator) nor in TypeScript's
// `lib.dom.d.ts`. Declare the spec shape locally so the typed
// `parameterDescriptors` getter (issue #3 §6.4 literal) typechecks. The
// `AutomationRate` string-literal union itself comes from `lib.dom.d.ts`.
interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: AutomationRate;
}

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
  // Cached views onto the WASM heap at the L/R output pointers. Computed
  // once via `subarray()` after `den_alloc` (and re-taken whenever the heap
  // grows and detaches the underlying ArrayBuffer). `process()` reuses these
  // for `output[ch].set(this.X_out_view)` so the audio render loop never
  // allocates a `Float32Array` view per render quantum (parent epic #1 §2:
  // "no heap allocation" on the audio thread).
  private l_out_view!: Float32Array;
  private r_out_view!: Float32Array;
  protected alive = true;

  // Render quantum (always 128 in Web Audio).
  private static readonly QUANTUM = 128;
  private static readonly BYTES_PER_BUFFER = DenProcessor.QUANTUM * 4;

  // Reused zero buffer for the disconnected-input steady state. Audio thread
  // is the wrong place for `new Float32Array(...)` per render quantum (parent
  // epic #1 §2: "no heap allocation" on the audio thread) — Web Audio passes
  // a length-0 array when the upstream is disconnected, and we substitute
  // this single shared silence buffer instead of allocating each call. Safe
  // to share across instances because every kernel reads inputs (`*const
  // f32`) and never writes them.
  private static readonly SILENT_INPUT = new Float32Array(DenProcessor.QUANTUM);

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
    this.refreshHeapViews(ex.memory as WebAssembly.Memory);
  }

  /**
   * (Re-)take the `Float32Array` view onto the WASM linear memory and the
   * cached subarray views onto the L/R output buffers. Called once from the
   * constructor and whenever `process()` detects that `memory.grow()` has
   * detached the previous backing `ArrayBuffer`. Subarray creation happens
   * here — NOT inside the render loop — so the audio thread stays
   * allocation-free during normal operation.
   */
  private refreshHeapViews(memory: WebAssembly.Memory): void {
    this.heap_f32 = new Float32Array(memory.buffer);
    const n = DenProcessor.QUANTUM;
    const l_out_f32 = this.l_out_ptr >> 2;
    const r_out_f32 = this.r_out_ptr >> 2;
    this.l_out_view = this.heap_f32.subarray(l_out_f32, l_out_f32 + n);
    this.r_out_view = this.heap_f32.subarray(r_out_f32, r_out_f32 + n);
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
    // Substitute the shared SILENT_INPUT static instead of allocating per
    // render quantum on the audio thread.
    const l_src = (input[0]?.length ?? 0) > 0 ? input[0]! : DenProcessor.SILENT_INPUT;
    const r_src = (input[1]?.length ?? 0) > 0 ? input[1]! : l_src;

    const n = DenProcessor.QUANTUM;
    const l_in_f32 = this.l_in_ptr >> 2;
    const r_in_f32 = this.r_in_ptr >> 2;

    // Re-take views in case memory grew (grow() invalidates prior buffers).
    // In normal steady-state operation this branch is NOT taken and no
    // allocation happens on the audio thread.
    const memory = this.instance.exports.memory as WebAssembly.Memory;
    if (this.heap_f32.buffer !== memory.buffer) {
      this.refreshHeapViews(memory);
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

    output[0].set(this.l_out_view);
    if (output[1]) output[1].set(this.r_out_view);

    return true;
  }
}

registerProcessor("den-processor", DenProcessor);
