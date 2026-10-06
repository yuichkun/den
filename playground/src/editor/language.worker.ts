import snapshot from 'virtual:den-types';
import { createEditorService } from './language-service.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';
const service = createEditorService(snapshot);
const worker = globalThis as unknown as { onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null; postMessage(value: WorkerResponse): void };
worker.onmessage = event => {
  const request = event.data;
  try { worker.postMessage({ id: request.id, result: service.query(request) }); }
  catch (error) { worker.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
};
