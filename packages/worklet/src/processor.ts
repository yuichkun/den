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

type Kernel = "passthrough" | "gain";

class DenProcessor extends AudioWorkletProcessor {
  private instance!: WebAssembly.Instance;
  private kernelId!: Kernel;

  // Pre-allocated WASM heap pointers. Freed only on explicit `dispose()`
  // via `{__denCmd: "destroy"}` port message (Sub D §6.2).
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

  // Per-kernel state and AudioParam scratch buffers. Allocated in the
  // constructor when needed (see kernel switch below); freed by the
  // destroy-message handler. `*_size` fields are remembered so the
  // matching `den_dealloc(ptr, size)` calls receive the exact size that
  // `den_alloc` was given (Layout::from_size_align in Rust requires the
  // matching {size, align}).
  private stateHeapPtr = 0;
  private stateHeapSize = 0;
  private paramScratchPtr = 0;
  private paramScratchSize = 0;

  private alive = true;

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

  // Every effect's continuous params live here. Effects that don't use a
  // given param simply ignore its `Float32Array` in `process()`.
  // Per the W3C spec, `parameterDescriptors` is evaluated once at
  // `registerProcessor` time, so the union below must list every param
  // any kernel uses.
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: "gain",
        defaultValue: 1,
        minValue: 0,
        maxValue: 10,
        automationRate: "a-rate",
      },
    ];
  }

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const po = options.processorOptions as {
      __denWasmBytes: ArrayBuffer;
      __denKernelId: Kernel;
      /**
       * Seed value for any kernel-side smoother. Effects whose constructor
       * accepts an initial-value option (e.g., `Gain`'s `gain` field)
       * forward that value here so the worklet's first quantum starts
       * AT the intended target rather than ramping from a hard-coded
       * unity. Defaults to 1.0 when the effect class doesn't pass one.
       */
      __denInitialGain?: number;
    };
    this.instance = instantiateSync(po.__denWasmBytes);
    this.kernelId = po.__denKernelId;

    const ex = this.instance.exports as unknown as {
      memory: WebAssembly.Memory;
      den_alloc(n: number): number;
      den_gain_size(): number;
      den_gain_init(state: number, sr: number, initial: number): void;
    };
    const bytes = DenProcessor.BYTES_PER_BUFFER;
    this.l_in_ptr = ex.den_alloc(bytes);
    this.r_in_ptr = ex.den_alloc(bytes);
    this.l_out_ptr = ex.den_alloc(bytes);
    this.r_out_ptr = ex.den_alloc(bytes);
    // `den_alloc` returns 0 (null) on OOM; without these guards a
    // subsequent kernel call would scribble at WASM linear-memory
    // offset 0. Dead processors return false from process() so the
    // host can GC us; the main thread sees a silenced node, which is
    // the closest approximation to "OOM" Web Audio gives us.
    //
    // Free any partially-successful allocations BEFORE the early
    // return. Without this, a constructor that allocs l_in_ptr +
    // r_in_ptr fine but fails on l_out_ptr would leak the first
    // two buffers — and since `port.onmessage` (the only later
    // dealloc path) hasn't been wired yet, those bytes stay leaked
    // for the lifetime of the AudioContext. Repeated OOM under low
    // memory would make every subsequent `new Gain(ctx)` more likely
    // to fail. `freeAllAllocations()` is null-safe per pointer so it
    // works even mid-allocation.
    if (
      this.l_in_ptr === 0 ||
      this.r_in_ptr === 0 ||
      this.l_out_ptr === 0 ||
      this.r_out_ptr === 0
    ) {
      this.freeAllAllocations();
      this.alive = false;
      return;
    }
    this.refreshHeapViews(ex.memory);

    // Per-kernel allocation. The processor file knows about every kernel
    // (because it dispatches them); each branch sets up exactly what its
    // kernel needs and nothing more. New kernels add their own branch
    // here AND in `process()` — Sub E's add-effect template codifies both.
    if (this.kernelId === "gain") {
      this.paramScratchSize = bytes; // QUANTUM * 4 = max a-rate length
      this.paramScratchPtr = ex.den_alloc(this.paramScratchSize);
      this.stateHeapSize = ex.den_gain_size();
      this.stateHeapPtr = ex.den_alloc(this.stateHeapSize);
      if (this.paramScratchPtr === 0 || this.stateHeapPtr === 0) {
        this.freeAllAllocations();
        this.alive = false;
        return;
      }
      // `sampleRate` is a global injected into every AudioWorkletGlobalScope
      // by the host (W3C Web Audio API §AudioWorkletGlobalScope). The
      // `initial` argument seeds the smoother to the user's intended
      // starting gain so the first quantum has no audible decay
      // transient — see Gain.ts for the JS side that forwards
      // `options.gain` into `__denInitialGain`.
      ex.den_gain_init(this.stateHeapPtr, sampleRate, po.__denInitialGain ?? 1.0);
    }

    // Listen for the explicit dispose signal from the main-thread effect
    // class. Web Audio has no JS-side destructor hook; without this path
    // each `new Gain(ctx)` would leak ~hundreds of bytes of WASM heap on
    // disposal. Returning `false` from a subsequent `process()` call lets
    // the host GC the processor (W3C spec, AudioWorkletProcessor.process).
    this.port.onmessage = (ev: MessageEvent) => {
      if (ev.data?.__denCmd === "destroy") {
        // Wrap the whole teardown in try/catch: a panic from
        // `den_dealloc` (e.g., layout-size mismatch) would otherwise
        // tear down the entire AudioWorkletGlobalScope and silently
        // kill every other effect on this context. We log and force
        // `alive = false` so at least the next `process()` returns
        // false and the host can GC.
        try {
          this.freeAllAllocations();
        } catch (err) {
          console.error("[den-processor] destroy failed:", err);
        } finally {
          this.alive = false;
        }
      } else if (ev.data?.__denCmd) {
        // Unknown den command — surface it so a future protocol typo
        // doesn't silently no-op. Plain user messages (no __denCmd
        // prefix) are NOT logged here so app code is free to use the
        // port for its own purposes once we add that capability.
        console.warn("[den-processor] unknown __denCmd:", ev.data.__denCmd);
      }
    };
  }

  /**
   * Free every WASM-side allocation owned by this processor. Null-safe
   * per pointer (each `if` guard skips already-freed slots), so this is
   * also the right thing to call from the constructor's OOM bail paths
   * — partial allocations get cleaned up before the early `return`.
   *
   * Free order: param scratch → state → I/O. Sizes MUST match the alloc
   * sizes exactly (Layout mismatch is a silent no-op in Rust's
   * allocator, leaving the bytes leaked). Calls go through
   * `dex.den_dealloc(...)` (method form) rather than via an extracted
   * reference so the `unbound-method` lint stays quiet — WASM exports
   * aren't class methods, but the linter can't know that.
   */
  private freeAllAllocations(): void {
    const dex = this.instance.exports as unknown as {
      den_dealloc(ptr: number, n: number): void;
    };
    if (this.paramScratchPtr) {
      dex.den_dealloc(this.paramScratchPtr, this.paramScratchSize);
      this.paramScratchPtr = 0;
      this.paramScratchSize = 0;
    }
    if (this.stateHeapPtr) {
      dex.den_dealloc(this.stateHeapPtr, this.stateHeapSize);
      this.stateHeapPtr = 0;
      this.stateHeapSize = 0;
    }
    this.disposeIoBuffers();
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
   * Free WASM-side I/O buffer allocations. Called from the destroy-message
   * handler. Sizes MUST match the `den_alloc` sizes exactly. Idempotent.
   * Private — there is no subclass today and Sub E's template specifies
   * `extends DenProcessor` only via composition, not inheritance.
   */
  private disposeIoBuffers(): void {
    const ex = this.instance.exports as unknown as {
      den_dealloc(ptr: number, n: number): void;
    };
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
    parameters: Record<string, Float32Array>,
  ): boolean {
    // Post-destroy: tell the host it can GC us. From this point onward
    // process() must not touch the (freed) WASM heap. Once we return
    // false, Web Audio promises no further calls.
    if (!this.alive) return false;

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

    const ex = this.instance.exports as unknown as {
      den_passthrough(l_in: number, r_in: number, l_out: number, r_out: number, n: number): void;
      den_gain_process(
        state_ptr: number,
        l_in: number,
        r_in: number,
        l_out: number,
        r_out: number,
        n: number,
        gain_values_ptr: number,
        n_gain_values: number,
      ): void;
    };

    switch (this.kernelId) {
      case "passthrough":
        ex.den_passthrough(this.l_in_ptr, this.r_in_ptr, this.l_out_ptr, this.r_out_ptr, n);
        break;
      case "gain": {
        // `parameters.gain` is a `Float32Array` of length 1 (k-rate, or
        // a-rate when no scheduled events fire this quantum) or `n`
        // (sample-accurate a-rate). Per W3C it is NEVER zero in the
        // worklet path. Copy into the scratch buffer so the kernel sees
        // a stable WASM-heap pointer regardless of the chunked layout.
        const gainValues = parameters.gain!;
        const pScratch = this.paramScratchPtr >> 2;
        this.heap_f32.set(gainValues, pScratch);
        ex.den_gain_process(
          this.stateHeapPtr,
          this.l_in_ptr,
          this.r_in_ptr,
          this.l_out_ptr,
          this.r_out_ptr,
          n,
          this.paramScratchPtr,
          gainValues.length,
        );
        break;
      }
    }

    output[0].set(this.l_out_view);
    if (output[1]) output[1].set(this.r_out_view);

    return true;
  }
}

registerProcessor("den-processor", DenProcessor);
