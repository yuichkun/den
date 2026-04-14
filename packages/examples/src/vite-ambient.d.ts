/// <reference types="vite/client" />

declare module "@denaudio/core/den_core.wasm?url" {
  const src: string;
  export default src;
}

declare module "@denaudio/worklet/processor.js?url" {
  const src: string;
  export default src;
}

declare module "@denaudio/worklet" {
  export interface RegisterOptions {
    wasmUrl?: string;
    workletUrl?: string;
  }
  export function registerDenWorklet(
    ctx: BaseAudioContext,
    options?: RegisterOptions,
  ): Promise<{ bytes: ArrayBuffer; workletModuleAdded: true }>;
  export function createDenNode(
    ctx: BaseAudioContext,
    kernelId: string,
    nodeOptions: AudioWorkletNodeOptions,
    registerOpts?: RegisterOptions,
  ): Promise<AudioWorkletNode>;
}
