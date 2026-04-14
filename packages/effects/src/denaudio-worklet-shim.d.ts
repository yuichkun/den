// Typecheck-only shim for `tsc --noEmit` (Vite resolves workspace packages at build).
declare module "@denaudio/worklet" {
  export interface RegisterOptions {
    wasmUrl?: string;
    workletUrl?: string;
  }
  export function createDenNode(
    ctx: BaseAudioContext,
    kernelId: string,
    nodeOptions: AudioWorkletNodeOptions,
    registerOpts?: RegisterOptions,
  ): Promise<AudioWorkletNode>;
}
