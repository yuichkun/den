import { compile, extractWorkletMeta, emitWorkletModuleSource } from "@unworklet/core";
import runtime from "virtual:den-kit-runtime";
import { makeProcessor } from "./processor.ts";
import type { Patch } from "./graph.ts";
const worker = globalThis as unknown as {
  onmessage:
    | ((
        e: MessageEvent<{
          id: number;
          patch: Patch;
        }>,
      ) => void)
    | null;
  postMessage(value: unknown, transfer?: Transferable[]): void;
};
worker.onmessage = async ({ data }) => {
  try {
    const compiled = await compile(makeProcessor(data.patch), { sampleRate: 48000 });
    const meta = extractWorkletMeta(
      compiled.graph as unknown as Parameters<typeof extractWorkletMeta>[0],
    );
    const processorName = `den-kit-${data.id}`;
    const moduleSource = emitWorkletModuleSource(meta, {
      processorName,
      runtime: { kind: "inline", code: runtime },
    });
    const wasm = Uint8Array.from(compiled.wasm).buffer;
    worker.postMessage({ id: data.id, result: { meta, moduleSource, wasm, processorName } }, [
      wasm,
    ]);
  } catch (error) {
    worker.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
