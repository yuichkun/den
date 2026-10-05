import { expect, test } from 'vitest';
import { audioInput, audioOutput, bool, CAPACITY_16, compile, decodeScalar, decodeSnapshot, defineProcessor, encodeScalar, encodeSnapshot, event, f32, f64, forSample, i32, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { residentTakeRecorder } from '../src/resident-recorder.js';
import { granularSource, samplePlayer } from '../src/sample.js';
import { takeReference, type TakeLoad, type TakeRow } from './fixtures/resident-recorder-reference.js';

const rates = [44100, 48000, 96000];
const duration = (frames: number, rate: number) => (frames - .25) / rate;
const inputs = (rows: readonly TakeRow[]) => [Float32Array.from(rows, r => r.input), Float32Array.from(rows, r => +r.record), Float32Array.from(rows, r => +r.reset), Float32Array.from(rows, r => r.position)];
function exact(actual: readonly Float32Array[], expected: readonly Float32Array[]) {
  expect(actual.length).toBe(expected.length);
  for (let ch = 0; ch < expected.length; ch++) expect(actual[ch]).toEqual(expected[ch]);
}
function makeProcessor(rate: number, capacity = 17, loop = false) {
  return defineProcessor(() => {
    const recorder = instantiate(residentTakeRecorder, { capacity, sampleRate: rate }, { name: 'take' });
    const input = audioInput({ channels: 4, name: 'controls' }), output = audioOutput({ channels: 7, name: 'main' });
    const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: (capacity + 3) * 4 });
    load.onReceive(x => recorder.sample.load(x.data));
    return { process() { forSample(i => {
      const position = f64(input.ch(3).at(i));
      const before = recorder.sample.read(position, i32(0), i32(capacity), loop), beforeLength = recorder.sample.length();
      const r = recorder.tick({ input: input.ch(0).at(i), record: input.ch(1).at(i).gt(0), reset: input.ch(2).at(i).gt(0) });
      const after = recorder.sample.read(position, i32(0), i32(capacity), loop);
      [before, f32(beforeLength), after, f32(r.length), f32(r.written), f32(r.full), f32(recorder.sample.revision())].forEach((value, ch) => output.ch(ch).at(i).write(value));
    }); } };
  });
}
function run(rate: number, rows: readonly TakeRow[], capacity = 17, loads: readonly TakeLoad[] = [], restore?: Uint8Array, loop = false) {
  return renderOffline(makeProcessor(rate, capacity, loop), { sampleRate: rate, duration: duration(rows.length, rate), inputs: { controls: inputs(rows) }, messages: loads.map(load => ({ name: 'load', payload: { data: load.data }, atQuantum: load.frame / 128 })), ...(restore ? { restore } : {}) });
}

for (const rate of rates) {
  test(`resident recorder all-sample independent append/pause/full/reset/read ordering ${rate}`, async () => {
    const rows = Array.from({ length: 1024 }, (_, n) => ({ input: Math.fround(Math.sin(n * .173) * 2), record: n % 23 > 3, reset: n === 127 || n >= 511 && n < 516, position: Math.fround((n % 29) / 2 - 2) }));
    for (const loop of [false, true]) {
      const result = await run(rate, rows, 17, [], undefined, loop);
      exact(result.outputs.main, takeReference(17, rows, [], loop).output);
      expect(result.diagnostics.scrubbedSamples).toBe(0);
    }
  });
  test(`resident recorder loaded prefix/recorded suffix interpolation, shorter/empty/oversize load ${rate}`, async () => {
    const loads = [
      { frame: 0, data: Float32Array.of(.125, -.375, .75) },
      { frame: 256, data: Float32Array.of(-2, 4) },
      { frame: 512, data: new Float32Array() },
      { frame: 640, data: Float32Array.from({ length: 20 }, (_, n) => n / 8) },
      { frame: 768, data: Float32Array.of(1e-35) },
    ];
    const rows = Array.from({ length: 1024 }, (_, n) => ({ input: Math.fround((n % 13 - 6) / 8), record: n % 7 !== 0, reset: n >= 897 && n <= 899, position: Math.fround([2.5, 1.5, 16, 0, .5, 9.25][n % 6]) }));
    const result = await run(rate, rows, 17, loads);
    exact(result.outputs.main, takeReference(17, rows, loads).output);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  });
  test(`resident recorder exact snapshots across loaded/recorded boundary and partial take ${rate}`, async () => {
    const rows = Array.from({ length: 768 }, (_, n) => ({ input: Math.fround(Math.sin(n * .01)), record: n >= 128 && n % 3 === 0, reset: n >= 511 && n < 514, position: Math.fround(n % 317 + .25) }));
    const loads = [{ frame: 0, data: Float32Array.from({ length: 84 }, (_, n) => n / 128) }];
    const full = await run(rate, rows, 319, loads);
    exact(full.outputs.main, takeReference(319, rows, loads).output);
    for (const split of [128, 256]) {
      const first = await run(rate, rows.slice(0, split), 319, loads);
      const rest = await run(rate, rows.slice(split), 319, [], first.state);
      exact(rest.outputs.main, full.outputs.main.map(ch => ch.slice(split)));
      expect(rest.diagnostics.scrubbedSamples).toBe(0);
      const decoded = decodeSnapshot(first.state);
      expect(decoded.slots.find(x => x.name === 'take/readPosition')).toBeUndefined();
      expect(decodeScalar('i32', decoded.slots.find(x => x.name === 'take/loadedPrefixLength')!.data)).toBe(84);
    }
  });
  test(`resident recorder capacity one, last frame and full never overwrite ${rate}`, async () => {
    const rows = Array.from({ length: 512 }, (_, n) => ({ input: Math.fround((n + 1) / 8), record: true, reset: n >= 255 && n <= 257, position: n % 2 ? Infinity : -Infinity }));
    const result = await run(rate, rows, 1);
    exact(result.outputs.main, takeReference(1, rows).output);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  });
}

test('recorded full finite f32 range, former native flush boundary, signed zeros and invalid inputs', async () => {
  const floor = Math.fround(1e-30), bits = new Uint32Array(Float32Array.of(floor).buffer)[0];
  const adjacent = (offset: number) => new Float32Array(Uint32Array.of(bits + offset).buffer)[0];
  const values = [0, -0, 2 ** -149, -(2 ** -149), 1e-35, -1e-35, adjacent(-1), -adjacent(-1), floor, -floor, adjacent(1), -adjacent(1), 3.4028234663852886e38, -3.4028234663852886e38, NaN, Infinity, -Infinity];
  for (const rate of rates) {
    const rows = Array.from({ length: 128 }, (_, n) => ({ input: Math.fround(values[n % values.length]), record: n < values.length, reset: false, position: Math.max(0, n < values.length ? n : n % values.length) }));
    const result = await run(rate, rows, values.length);
    exact(result.outputs.main, takeReference(values.length, rows).output);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
    const snapshot = decodeSnapshot(result.state), bytes = snapshot.slots.find(x => x.name === 'take/recordedPCM')!.data;
    const stored = new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    values.forEach((value, n) => expect(stored[n] / 2 ** 128).toBe(Number.isFinite(value) && value !== 0 ? Math.fround(value) : 0));
    expect(stored[values.length]).toBe(0);
  }
});

test('paused/full/reset sentinel never changes exposed tiny event-loaded PCM; clear is logical only', async () => {
  const data = Float32Array.of(2 ** -149, -1e-35, 1e-35), capacity = 3;
  const rows = Array.from({ length: 384 }, (_, n) => ({ input: 17, record: n < 256, reset: n >= 256, position: n % 3 }));
  const result = await run(48000, rows, capacity, [{ frame: 0, data }]);
  exact(result.outputs.main, takeReference(capacity, rows, [{ frame: 0, data }]).output);
  const slots = decodeSnapshot(result.state).slots;
  expect(slots.find(x => x.name === 'take/loadedPCM')!.data).toEqual(new Uint8Array(data.buffer));
  expect(decodeScalar('i32', slots.find(x => x.name === 'take/length')!.data)).toBe(0);
  expect(decodeScalar('i32', slots.find(x => x.name === 'take/loadedPrefixLength')!.data)).toBe(0);
});

test('prefix/suffix interpolation retains tiny positions against full finite PCM and clamps invalid positions', async () => {
  const positions = [1e-35, 2 ** -149, .5, 1, NaN, Infinity, -Infinity, -1e20, 1e20];
  for (const rate of rates) {
    const rows = Array.from({ length: 128 }, (_, n) => ({ input: Math.fround(3.4028234663852886e38), record: n === 0, reset: false, position: Math.fround(positions[n % positions.length]) }));
    const loads = [{ frame: 0, data: Float32Array.of(0) }];
    const result = await run(rate, rows, 2, loads);
    exact(result.outputs.main, takeReference(2, rows, loads).output);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
});

test('logical reset leaves recorded suffix bytes intact while all reads become silent', async () => {
  const rows = Array.from({ length: 256 }, (_, n) => ({ input: Math.fround((n + 1) / 8), record: true, reset: n >= 128, position: n % 17 }));
  const result = await run(48000, rows, 17), first = await run(48000, rows.slice(0, 128), 17);
  const buffer = (snapshot: Uint8Array) => decodeSnapshot(snapshot).slots.find(x => x.name === 'take/recordedPCM')!.data;
  expect(buffer(result.state)).toEqual(buffer(first.state));
  expect(result.outputs.main[2].slice(128)).toEqual(new Float32Array(128));
});

test('revision wraps on reset/load and append does not invalidate a growing sample player', async () => {
  const processor = defineProcessor(() => {
    const take = instantiate(residentTakeRecorder, { capacity: 1024, sampleRate: 48000 }, { name: 'take' });
    const player = instantiate(samplePlayer, { sampleRate: 48000, sample: take.sample, loop: true }, { name: 'player' });
    const input = audioInput({ channels: 4, name: 'controls' }), out = audioOutput({ channels: 3, name: 'main' });
    return { process() { forSample(i => {
      take.tick({ input: input.ch(0).at(i), record: bool(true), reset: input.ch(2).at(i).gt(0) });
      const p = player.tick({ gate: bool(true), trigger: input.ch(1).at(i).gt(0), reset: bool(false), rate: f32(1) });
      out.ch(0).at(i).write(p.output); out.ch(1).at(i).write(f32(p.active)); out.ch(2).at(i).write(f32(take.sample.revision()));
    }); } };
  });
  const rows = Array.from({ length: 512 }, (_, n) => ({ input: (n % 31) / 32, record: n === 270, reset: n >= 255 && n < 258, position: 0 }));
  const result = await renderOffline(processor, { sampleRate: 48000, duration: duration(512, 48000), inputs: { controls: inputs(rows) } });
  const tape: number[] = [], expected = [new Float32Array(512), new Float32Array(512), new Float32Array(512)];
  let phase = 0, active = false, revision = 0, previousRevision = -1;
  rows.forEach((r, n) => {
    if (r.reset) { tape.length = 0; revision++; } else tape.push(r.input);
    const trigger = (n === 0 || r.record) && tape.length > 0;
    active = (trigger || active && previousRevision === revision) && tape.length > 0;
    if (trigger) phase = 0;
    expected[0][n] = active ? tape[phase] : 0; expected[1][n] = +active; expected[2][n] = revision;
    phase = (phase + 1) % Math.max(1, tape.length); previousRevision = revision;
  });
  exact(result.outputs.main, expected); expect(result.diagnostics.scrubbedSamples).toBe(0);
  const seed = await run(48000, rows.slice(0, 128), 17);
  for (const before of [2147483647, -1]) {
    const snapshot = decodeSnapshot(seed.state); snapshot.slots.find(x => x.name === 'take/revision')!.data = encodeScalar('i32', before);
    const restored = encodeSnapshot(snapshot.schemaHash, snapshot.profile, snapshot.slots, snapshot.processorId);
    const resetRows = rows.slice(0, 128).map((r, n) => ({ ...r, reset: n === 0, record: true }));
    const result = await run(48000, resetRows, 17, [], restored);
    expect(result.outputs.main[6]).toEqual(new Float32Array(128).fill((before + 1) | 0));
  }
});

test('recorded take composes with existing granular source and immutable resident interface', async () => {
  for (const rate of rates) {
    const processor = defineProcessor(() => {
      const take = instantiate(residentTakeRecorder, { capacity: 1, sampleRate: rate }, { name: 'take' });
      const grain = instantiate(granularSource, { sampleRate: rate, sample: take.sample, maxGrains: 1, loop: true }, { name: 'grain' });
      const output = audioOutput({ channels: 1, name: 'main' });
      return { process() { forSample(i => {
        take.tick({ input: f32(2), record: bool(true), reset: bool(false) });
        const g = grain.tick({ gate: bool(true), reset: bool(false), positionFrames: f32(0), jitterFrames: f32(0), rate: f32(1), durationSeconds: f32(7 / rate), densityHz: f32(0) });
        output.ch(0).at(i).write(g.output);
      }); } };
    });
    const result = await renderOffline(processor, { sampleRate: rate, duration: duration(128, rate) });
    const expected = Float32Array.from({ length: 128 }, (_, n) => n < 7 ? 2 * Math.max(0, 1 - Math.abs(2 * n / 6 - 1)) : 0);
    expect(result.outputs.main[0]).toEqual(expected); expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
});

test('maximum capacity is bounded, records final slot exactly and preserves fixed memory', { timeout: 30000 }, async () => {
  const capacity = 65536, rows = Array.from({ length: capacity + 128 }, (_, n) => ({ input: (n % 257 - 128) / 128, record: true, reset: false, position: n }));
  for (const rate of rates) {
    const result = await run(rate, rows, capacity);
    exact(result.outputs.main, takeReference(capacity, rows).output); expect(result.diagnostics.scrubbedSamples).toBe(0);
    const buffers = decodeSnapshot(result.state).slots.filter(x => x.kind === 'buffer');
    expect(buffers.reduce((sum, x) => sum + x.data.byteLength, 0)).toBe(12 * capacity + 8);
  }
  const compiled = await compile(makeProcessor(48000, capacity), { sampleRate: 48000 }), driver = await compiled.driver.instantiate();
  const bytes = driver.memory.buffer.byteLength;
  for (let n = 0; n < 64; n++) driver.process();
  expect(driver.memory.buffer.byteLength).toBe(bytes); expect(driver.scrubbedSamples()).toBe(0);
});

test('invalid fixed construction fails before rendering', () => {
  for (const capacity of [0, -1, 1.5, 65537, NaN, Infinity]) expect(() => makeProcessor(48000, capacity)).toThrow(RangeError);
  for (const rate of [7999, 192001, NaN, Infinity, -Infinity]) expect(() => makeProcessor(rate)).toThrow(RangeError);
  for (const rate of [8000, 192000]) expect(() => makeProcessor(rate, 1)).not.toThrow();
});
