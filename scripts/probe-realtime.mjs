import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConsumer } from './build-consumer.mjs';
import { captureRealtime } from '../tests/realtime/capture.mjs';

// Manual evidence uses the original isolated fixture, never public site-dist.
export async function runRealtimeProbe({ build = buildConsumer, capture = captureRealtime } = {}) {
  const { output } = build({ stageSite: false });
  return capture(output, 'artifacts/realtime/manual');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runRealtimeProbe();
}
