// Typecheck-only shim: Vite resolves `@denaudio/core` at build time; `tsc --noEmit` does not bundle.
declare module "@denaudio/core" {
  export function fetchWasmBytes(url?: string): Promise<ArrayBuffer>;
}
