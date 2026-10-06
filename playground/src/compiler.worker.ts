import { compile, emitWorkletModuleSource, extractWorkletMeta } from '@unworklet/core';
import { makeWorkletNamespaceFromMeta } from '@unworklet/core/worklet';
import snapshot from 'virtual:den-types';
import registry from 'virtual:den-modules';
import runtime from 'virtual:den-runtime';
import { createTypeProject } from './typescript-project.ts';
import { evaluateSource } from './evaluate-source.ts';
import { readSetup } from './sample-setup.ts';
const worker = globalThis as unknown as { onmessage: ((event: MessageEvent<{ id: number; source: string }>) => void) | null; postMessage(value: unknown, transfer?: Transferable[]): void };
worker.onmessage = async event => {
  const { id, source } = event.data;
  let project: ReturnType<typeof createTypeProject> | undefined;
  try {
    if (typeof source !== 'string' || source.length > 200000) throw new Error('Source must be at most 200,000 characters.');
    worker.postMessage({ id, phase: 'Checking types' });
    project = createTypeProject(snapshot); project.sync(source);
    const diagnostics = project.diagnostics();
    if (diagnostics.some(d => d.severity === 'error')) { worker.postMessage({ id, error: 'Fix the TypeScript errors before running.', diagnostics }); return; }
    project.dispose(); project = undefined;
    worker.postMessage({ id, phase: 'Compiling' });
    const { processor, exports } = evaluateSource(source, registry);
    const setup = readSetup(exports);
    const compiled = await compile(processor, { sampleRate: 48000 });
    const meta = extractWorkletMeta(compiled.graph as unknown as Parameters<typeof extractWorkletMeta>[0]);
    if (!makeWorkletNamespaceFromMeta(meta).outputs.some(output => output.name === 'main' && output.channels >= 1 && output.channels <= 2)) throw new Error('The example needs a main audio output with one or two channels.');
    const processorName = `den-playground-${id}`;
    const moduleSource = emitWorkletModuleSource(meta, { processorName, runtime: { kind: 'inline', code: runtime } });
    const wasm = Uint8Array.from(compiled.wasm).buffer;
    worker.postMessage({ id, result: { meta, setup, moduleSource, wasm, processorName, sampleRate: 48000 } }, [wasm]);
  } catch (error) { worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
  finally { project?.dispose(); }
};
