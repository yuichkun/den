import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compile } from '@unworklet/core';
import * as examples from '@denaudio/den/musical-examples';
import { checkMaterials, fixture, checkExample, checkResetAndAssets, metrics, hash } from './checks.mjs';
checkMaterials(examples);
const reports = [], profiles = [];
const names = ['glassDyad', 'fmModalHit', 'grainCloud', 'shapedEcho'];
for (const sampleRate of [44100, 48000, 96000]) for (const name of names) {
  let baseline;
  for (const variant of [0, 1]) {
    const f = fixture(examples, name, variant, sampleRate), began = performance.now();
    let differenceFromA;
    const result = await checkExample(examples, f, { snapshots: variant === 0, repeat: true, save: writeFileSync,
      onAudio: channels => {
        if (variant === 0) baseline = channels;
        else {
          const difference = metrics(channels.map((ch, c) => Float32Array.from(ch, (x, n) => x - baseline[c][n])));
          differenceFromA = { rms: difference.rms, relativeToARms: difference.rms / metrics(baseline).rms };
          assert(differenceFromA.relativeToARms > .1, `${name}: A/B difference must exceed 10% of A RMS`);
        }
      },
    });
    if (differenceFromA) result.differenceFromA = differenceFromA;
    result.offlineWallMs = performance.now() - began;
    reports.push(result); console.log(JSON.stringify(result));
  }
  const [a, b] = reports.slice(-2);
  assert.notDeepEqual(a.pcmSHA256, b.pcmSHA256, `${name}: A and B must sound different`);
}
for (const name of names) {
  await checkResetAndAssets(examples, name);
  const built = await compile(examples[name], { sampleRate: 48000 }), driver = await built.driver.instantiate();
  const memoryBytes = driver.memory.buffer.byteLength;
  assert(built.wasm.byteLength < 256 * 1024, `${name}: bounded example WASM size`);
  assert(memoryBytes < 4 * 1024 * 1024, `${name}: bounded example memory`);
  profiles.push({ name, sampleRate: 48000, wasmBytes: built.wasm.byteLength, wasmSHA256: hash(built.wasm), memoryBytes,
    observation: 'Instantiation allocation only. No loaded callback deadline measurement or hardware/browser clearance.' });
}
writeFileSync('musical-examples-results.json', JSON.stringify({ status: 'CANDIDATE', sampleRates: [44100, 48000, 96000],
  reports, profiles, verification: 'Packed public entry, independent composition oracles, native parameter edits, exact snapshot continuation, repeat PCM, conservative output guards and tail/reset/asset lifecycle checks',
  limitations: ['No human listening approval or approved golden', 'No browser or real-time deadline certification',
    'Snapshots continue only at matching graph/schema/rate with host params reapplied',
    'Headroom applies to the supplied original materials and tested timelines; edits or external assets need new checks',
    'End-of-tail threshold is not exact silence for modal/filter/feedback tails',
    'No automatic bandlimiting, MIDI/voice allocator, asset loader, framework or normalization'],
}, null, 2));
