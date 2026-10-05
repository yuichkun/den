import { expect, test } from 'vitest';
import { audioInput, audioOutput, compile, defineProcessor, defineSubgraph, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { stftIdentity } from '../src/spectral.js';
import { createStftIdentity as frozen } from './probes/stft-before-gate-hook.js';
const previous = defineSubgraph(config => frozen(config as { size: number; hopSize: number }, 1024));
function fixture(unit: typeof stftIdentity, size: number, hopSize: number) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 2, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
    const stft = instantiate(unit, { size, hopSize }, { name: 'stft' });
    return { process() { forSample((i, everyNSamples) => output.ch(0).at(i).write(stft.tick(input.ch(0).at(i), input.ch(1).at(i).gt(0), everyNSamples))); } };
  }, { id: 'den.spectral.identity.frozen-4be1c99' });
}
for (const rate of [44100, 48000, 96000]) test(`no-hook identity preserves exact WASM, schema, PCM and bidirectional snapshots at ${rate}`, async () => {
  for (const [size, hop] of [[8, 2], [64, 32], [256, 64], [512, 256], [1024, 256], [1024, 512]]) {
    const old = fixture(previous as typeof stftIdentity, size, hop), next = fixture(stftIdentity, size, hop);
    const oldCompiled = await compile(old, { sampleRate: rate }), nextCompiled = await compile(next, { sampleRate: rate });
    expect(nextCompiled.schemaHash).toBe(oldCompiled.schemaHash);
    expect(nextCompiled.wasm).toEqual(oldCompiled.wasm);
    const count = 4 * Math.max(128, size), input = Float32Array.from({ length: count }, (_, n) => [2 ** -149, 1e-29, -0.8, 0.2, 1][n % 5]);
    const resets = new Float32Array(count); resets[127] = 1; resets[257] = 1;
    const render = (p: typeof old, start = 0, end = count, restore?: Uint8Array) => renderOffline(p, { sampleRate: rate, duration: (end - start - 0.25) / rate, inputs: { main: [input.slice(start, end), resets.slice(start, end)] }, restore });
    const reference = await render(old), current = await render(next);
    expect(current.outputs.main[0]).toEqual(reference.outputs.main[0]); expect(current.state).toEqual(reference.state);
    const split = count - 128, a = await render(old, 0, split), b = await render(next, 0, split);
    expect(a.state).toEqual(b.state);
    for (const [p, restore] of [[old, b.state], [next, a.state]] as const) {
      const resumed = await render(p, split, count, restore);
      expect(resumed.outputs.main[0]).toEqual(reference.outputs.main[0].slice(split)); expect(resumed.state).toEqual(reference.state);
    }
  }
}, 60000);
