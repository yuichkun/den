import { expect, test } from 'vitest';
import { compile, decodeScalar, decodeSnapshot } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { liveGrainProcessor } from './fixtures/live-granular-processor.js';
import { liveGrainError, liveGrainPorts, liveGrainReference, liveGrainRows, type LiveGrainRow } from './fixtures/live-granular-reference.js';
const rates = [44100, 48000, 96000];
async function run(rows: readonly LiveGrainRow[], rate = 48000, capacity = 257, maxGrains = 8, restore?: Uint8Array) {
  const result = await renderOffline(liveGrainProcessor(capacity, maxGrains), { sampleRate: rate, duration: (rows.length - .25) / rate, inputs: { controls: liveGrainPorts(rows) }, restore });
  expect(result.diagnostics.scrubbedSamples).toBe(0); expect(result.outputs.main.every(c => c.every(Number.isFinite))).toBe(true);
  return result;
}
function compare(actual: Float32Array[], expected: Float32Array[], tolerance = 2e-7) {
  expect(liveGrainError(actual[0], expected[0])).toBeLessThanOrEqual(tolerance);
  actual.slice(1).forEach((ch, n) => expect(ch, `status channel ${n + 1}`).toEqual(expected[n + 1]));
}
test('maximum fixed pool feasibility: eight active grains and 65536 history, no allocation growth', async () => {
  const rows = liveGrainRows(512, n => ({ trigger: n < 8, seconds: 2 }));
  const result = await run(rows, 48000, 65536, 8);
  expect(result.outputs.main[1].slice(7)).toEqual(new Float32Array(505).fill(8));
  const compiled = await compile(liveGrainProcessor(65536, 8), { sampleRate: 48000 });
  const driver = await compiled.driver.instantiate(), bytes = driver.memory.buffer.byteLength;
  for (let i = 0; i < 16; i++) driver.process();
  expect(driver.memory.buffer.byteLength).toBe(bytes);
  const slots = decodeSnapshot(result.state).slots;
  expect(slots.filter(s => s.kind === 'buffer').map(s => s.data.byteLength)).toEqual([8 * 65537]);
  expect(slots.some(s => s.name === 'grains/allocated')).toBe(false);
  expect(slots.filter(s => s.name.startsWith('grains/'))).toHaveLength(40);
  console.log(JSON.stringify({ candidate: 'live-granular maximum pool', wasmBytes: compiled.wasm.byteLength, memoryBytes: bytes, persistentBytes: result.state.byteLength, capacity: 65536, maxGrains: 8 }));
});
for (const rate of rates) {
  test(`absolute source-identity reference, mixed accepted writes, signed rates, pause/resume and wrap at ${rate}`, async () => {
    const rows = liveGrainRows(2048, n => ({ input: Math.sin(n * .173) * 1.3, record: n % 7 > 1 && !(n >= 768 && n < 1024), reset: n >= 1531 && n <= 1535, trigger: n % 3 === 0 || n >= 1000 && n < 1040, age: [0, .25, 1.5, 8, 15.75, 16, 17][n % 7], rate: [-16, -1, -.25, 0, .25, 1, 2, 16][n % 8], seconds: [0, 5 / rate, 17 / rate, 2][n % 4] }));
    for (const pool of [1, 8]) { const result = await run(rows, rate, 17, pool); compare(result.outputs.main, liveGrainReference(17, pool, rate, rows)); }
  });
  test(`three-frame and odd/even triangular windows, endpoint active counts, latched controls ${rate}`, async () => {
    for (const N of [3, 4, 5, 8]) {
      const rows = liveGrainRows(128, n => ({ input: 2, record: n < 8, trigger: n === 8, rate: n === 8 ? 0 : 16, age: n === 8 ? 0 : 999, seconds: n === 8 ? (N === 3 ? 0 : N / rate) : NaN }));
      const result = await run(rows, rate, 8, 1), out = result.outputs.main;
      compare(out, liveGrainReference(8, 1, rate, rows));
      expect(Array.from(out[0].slice(8, 8 + N))).toEqual(Array.from({ length: N }, (_, k) => Math.fround(2 * (1 - Math.abs(2 * k / (N - 1) - 1)))));
      expect(out[1].slice(8, 8 + N)).toEqual(new Float32Array(N).fill(1));
      expect(out[1][8 + N]).toBe(0); expect(out[5].every(x => x === 0)).toBe(true);
    }
  });
  test(`same-schema continuation with writer and reader through active/full/paused/reset states ${rate}`, async () => {
    const rows = liveGrainRows(1536, n => ({ input: .5 * Math.sin(n / 31), record: !(n >= 384 && n < 640), reset: n >= 767 && n <= 771, trigger: n % 37 === 0, age: 8, rate: [0, .5, 1][Math.floor(n / 37) % 3], seconds: .1 }));
    const full = await run(rows, rate, 257, 8); compare(full.outputs.main, liveGrainReference(257, 8, rate, rows));
    for (const split of [128, 384, 512, 768, 1024]) {
      const prefix = await run(rows.slice(0, split), rate, 257, 8), suffix = await run(rows.slice(split), rate, 257, 8, prefix.state);
      expect(suffix.outputs.main).toEqual(full.outputs.main.map(c => c.slice(split)));
      const names = decodeSnapshot(prefix.state).slots.map(s => s.name);
      expect(names).not.toContain('grains/allocated'); expect(names).not.toContain('history/readAge');
      expect(names).toContain('history/pcm'); expect(names).toContain('grains/grain7AgeScaled');
    }
  });
}

test('first-free saturation, no stealing/queue, held requests and natural completion before expiry', async () => {
  const rows = liveGrainRows(128, n => ({ record: n < 4, input: 1, trigger: n >= 4 && n < 14, rate: 0, seconds: 5 / 48000 }));
  const result = await run(rows, 48000, 4, 2), out = result.outputs.main;
  compare(out, liveGrainReference(4, 2, 48000, rows));
  expect(Array.from(out[2].slice(4, 14))).toEqual([1, 1, 0, 0, 0, 1, 1, 0, 0, 0]);
  expect(Array.from(out[3].slice(4, 14))).toEqual([0, 0, 1, 1, 1, 0, 0, 1, 1, 1]);
  const done = liveGrainRows(128, n => ({ record: true, trigger: n === 0, age: 0, rate: 0, seconds: 0 }));
  const ended = await run(done, 48000, 3, 1);
  expect(Array.from(ended.outputs.main[1].slice(0, 5))).toEqual([1, 1, 1, 0, 0]);
  expect(ended.outputs.main[5].every(x => x === 0)).toBe(true);
});

test('overwritten slot is immediately reusable; no stale endpoint clamp or recovery', async () => {
  const rows = liveGrainRows(128, n => ({ input: n + 1, trigger: n === 2 || n === 3, age: 1, rate: 0, seconds: 2 }));
  const r = await run(rows, 48000, 2, 1); compare(r.outputs.main, liveGrainReference(2, 1, 48000, rows));
  expect(r.outputs.main[2][3]).toBe(1); expect(r.outputs.main[5][3]).toBe(1); expect(r.outputs.main[3][3]).toBe(0);
  expect(r.outputs.main[5][4]).toBe(1); expect(r.outputs.main[1].slice(4).every(x => x === 0)).toBe(true);
});

test('zero newest margin may give only a silent onset; pause moves the grain and resume cannot revive it', async () => {
  const rows = liveGrainRows(128, n => ({ record: n < 2 || n >= 16, trigger: n === 2, age: 0, rate: 1, seconds: 2 }));
  const result = await run(rows, 48000, 8, 1); compare(result.outputs.main, liveGrainReference(8, 1, 48000, rows));
  expect(result.outputs.main[2][2]).toBe(1); expect(result.outputs.main[1][2]).toBe(1); expect(result.outputs.main[5][3]).toBe(1);
  expect(result.outputs.main[0].every(x => x === 0)).toBe(true); expect(result.outputs.main[1].slice(3).every(x => x === 0)).toBe(true);
});

test('invalid eager-select operands reject safely while active grains continue; reset defeats all flags', async () => {
  const values = [NaN, Infinity, -Infinity, -(2 ** -149), 0, 2, Math.fround(2 + 2 ** -21)];
  const rows = liveGrainRows(512, n => ({ record: n < 16, trigger: n >= 16, age: n < 32 ? 0 : [NaN, Infinity, -Infinity, -.25, 15, 15.5, 16, 0][n % 8], rate: n < 32 ? 0 : [NaN, Infinity, -Infinity, -16, 16, 17, -17, 0][n % 8], seconds: n === 16 ? 2 : values[n % values.length], reset: n >= 256 && n < 260 }));
  const r = await run(rows, 48000, 16, 8); compare(r.outputs.main, liveGrainReference(16, 8, 48000, rows));
  expect(r.outputs.main[4].some(x => x === 1)).toBe(true);
  for (const ch of r.outputs.main.slice(0, 6)) expect(ch.slice(256, 260)).toEqual(new Float32Array(4));
});

test('tiny fractions survive cancelled writer/rate increments and tiny latched signed rates', async () => {
  const max = Math.fround(3.4028234663852886e38), tiny = 2 ** -149;
  for (const sampleRate of rates) for (const mode of ['cancel', 'rate']) {
    const rows = liveGrainRows(128, n => ({ input: mode === 'cancel' ? (n === 1 ? max : 0) : (n === 0 ? max : 0), record: mode === 'cancel' || n < 2, trigger: n === 1, age: mode === 'cancel' ? tiny : 0, rate: mode === 'cancel' ? 1 : -tiny, seconds: 0 }));
    const r = await run(rows, sampleRate, 2, 1), expected = liveGrainReference(2, 1, sampleRate, rows);
    expect(r.outputs.main).toEqual(expected);
    expect(r.outputs.main[0][2]).toBe(Math.fround(max * tiny));
    expect(r.outputs.main[0][2]).toBeGreaterThan(0);
  }
});

test('finite full-range PCM, subnormals, invalid input and fixed pool headroom', async () => {
  const max = Math.fround(3.4028234663852886e38), tiny = 2 ** -149;
  for (const scale of [max, tiny * 16, Math.fround(1e-35), 3]) {
    const rows = liveGrainRows(384, n => ({ input: (n % 7 - 3) / 4 * scale, trigger: n % 3 === 0, age: n % 5 / 4, rate: [0, .5, 1, 2][n % 4], seconds: 17 / 48000 }));
    const r = await run(rows, 48000, 17, 8), expected = liveGrainReference(17, 8, 48000, rows);
    compare(r.outputs.main.map((c, j) => j ? c : Float32Array.from(c, x => x / scale)), expected.map((c, j) => j ? c : Float32Array.from(c, x => x / scale)), scale === tiny * 16 ? 1 / 16 : 2e-7);
    expect(r.outputs.main[0].some(x => x !== 0)).toBe(true);
    expect(r.outputs.main[0].every(x => Math.abs(x) <= Math.abs(scale))).toBe(true);
  }
  const rows = liveGrainRows(128, n => ({ input: [NaN, Infinity, -Infinity, -0][n % 4], trigger: true, rate: 1, seconds: 0 }));
  const r = await run(rows, 48000, 1, 8); expect(r.outputs.main[0].every(x => x === 0)).toBe(true);
});

test('maximum history remains live through two wraps with eight fixed grains', async () => {
  const frames = 131200, rows = liveGrainRows(frames, n => ({ input: .25, trigger: n < 8, age: 0, rate: 1, seconds: 2 }));
  const r = await run(rows, 48000, 65536, 8);
  for (const n of [7, 127, 32768, 65535, 65536, 95999, 96006, 131199]) {
    let expected = 0, active = 0;
    for (let start = 0; start < 8; start++) { const k = n - start; if (k >= 0 && k < 96000) { expected += .25 * (1 - Math.abs(2 * k / 95999 - 1)) / 8; active++; } }
    expect(r.outputs.main[0][n]).toBe(Math.fround(expected)); expect(r.outputs.main[1][n]).toBe(active);
  }
  expect(r.outputs.main[5].every(x => x === 0)).toBe(true);
  expect(decodeSnapshot(r.state).slots.filter(s => s.kind === 'buffer').map(s => s.data.byteLength)).toEqual([8 * 65537]);
});

test('construction bounds and the supported smallest history/pool', async () => {
  for (const pool of [0, -1, 1.5, 9, NaN, Infinity]) expect(() => liveGrainProcessor(8, pool)).toThrow(/maxGrains/);
  const rows = liveGrainRows(128, n => ({ trigger: n === 0, seconds: 0 }));
  for (const sampleRate of [8000, 192000]) { const r = await run(rows, sampleRate, 1, 1); compare(r.outputs.main, liveGrainReference(1, 1, sampleRate, rows)); }
});


test('first-free slot order is visible in persistent state, not just aggregate audio', async () => {
  const rows = liveGrainRows(128, n => ({ record: n < 16, trigger: n >= 125, age: n >= 125 ? n - 124 : 0, rate: 0, seconds: n >= 125 ? (n - 120) / 1000 : 0 }));
  const r = await run(rows, 48000, 16, 3), slots = decodeSnapshot(r.state).slots;
  for (let j = 0; j < 3; j++) {
    const get = (suffix: string) => slots.find(s => s.name === `grains/grain${j}${suffix}`)!.data;
    expect(decodeScalar('f64', get('AgeScaled')) / 2 ** 192).toBe(j + 1);
    expect(decodeScalar('i32', get('Index'))).toBe(3 - j);
    expect(decodeScalar('i32', get('Duration'))).toBe(Math.floor(Math.fround((j + 5) / 1000) * 48000 + .5));
  }
});
