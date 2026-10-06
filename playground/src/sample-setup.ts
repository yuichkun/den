import type { MidiEvent } from '@unworklet/core';
export type SampleSetup = {
  initial: Record<string, number>;
  afterReady: Record<string, number>;
  events: { name: string; payload: unknown }[];
  midi: { port: string; event: MidiEvent }[];
  ready: { suffix: string; value: number | boolean }[];
};
export function readSetup(exports: Record<string, unknown>): SampleSetup {
  const numbers = (name: string): Record<string, number> => {
    const value = exports[name] ?? {};
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 256) throw new Error(`${name} must be a numeric AudioParam map.`);
    for (const [key, number] of Object.entries(value)) if (typeof number !== 'number' || !Number.isFinite(number)) throw new Error(`${name}.${key} must be finite.`);
    return { ...value } as Record<string, number>;
  };
  const list = (name: string, limit: number) => {
    const value = exports[name] ?? [];
    if (!Array.isArray(value) || value.length > limit) throw new Error(`${name} must be an array of at most ${limit} items.`);
    return value as Record<string, unknown>[];
  };
  const events = list('events', 128).map(value => {
    if (!value || typeof value.name !== 'string' || !value.name || !Object.hasOwn(value, 'payload')) throw new Error('Each events item needs a native event name and payload.');
    return { name: value.name, payload: value.payload };
  });
  const midi = list('midi', 64).map(value => {
    if (!value || typeof value.port !== 'string' || !value.port || !value.event || typeof value.event !== 'object') throw new Error('Each midi item needs a native port and event.');
    return { port: value.port, event: value.event as MidiEvent };
  });
  const ready = list('ready', 64).map(value => {
    if (!value || typeof value.suffix !== 'string' || !value.suffix || !(typeof value.value === 'boolean' || (typeof value.value === 'number' && Number.isFinite(value.value)))) throw new Error('Each ready item needs a state suffix and finite numeric or boolean value.');
    return { suffix: value.suffix, value: value.value as number | boolean };
  });
  const setup = { initial: numbers('initial'), afterReady: numbers('afterReady'), events, midi, ready };
  // Structured data only crosses the worker boundary; it never contains callbacks.
  const cloned = structuredClone(setup);
  let bytes = 0, values = 0;
  const seen = new WeakSet<object>();
  const count = (value: unknown): void => {
    if (++values > 200000) throw new Error('Sample setup is too large.');
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) bytes += value.byteLength;
    else for (const child of Object.values(value)) count(child);
  };
  count(cloned);
  if (bytes > 4 * 1024 * 1024) throw new Error('Prepared sample payloads must total at most 4 MiB.');
  return cloned;
}
