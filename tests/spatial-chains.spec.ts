import { test, expect, vi } from 'vitest';
import { audioInput, audioOutput, compile, decodeSnapshot, defineProcessor, f32, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { hybridReverb, feedforwardPitchedReverb, type SpatialChainConfig, type FeedforwardPitchedReverbConfig } from '../src/spatial-chains.js';
import { maxError, spatialPorts as ports, spatialReference } from './fixtures/spatial-chains-reference.js';
import { complexBin } from './fixtures/windowed-pitch-shift-reference.js';

const rates = [44100, 48000, 96000];
vi.setConfig({ testTimeout: 60000 });
function fixture(width?: number) {
  return defineProcessor(ctx => {
    const input = audioInput({ name: 'main', channels: 7 }), output = audioOutput({ name: 'main', channels: width === undefined ? 2 : 3 });
    const plain = width === undefined ? instantiate(hybridReverb, { sampleRate: ctx.sampleRate }, { name: 'space' }) : undefined;
    const pitched = width === undefined ? undefined : instantiate(feedforwardPitchedReverb, { sampleRate: ctx.sampleRate, windowSamples: width }, { name: 'space' });
    return { process() { forSample((i, everyNSamples) => {
      const c = { mix: input.ch(1).at(i), bypass: input.ch(2).at(i).gt(0), reset: input.ch(3).at(i).gt(0) };
      if (plain) {
        const r = plain.tick(input.ch(0).at(i), c, everyNSamples);
        output.ch(0).at(i).write(r.left); output.ch(1).at(i).write(r.right);
      } else if (pitched) {
        const r = pitched.tick(input.ch(0).at(i), { ...c, ratio: input.ch(4).at(i), pitchMix: input.ch(5).at(i), retrigger: input.ch(6).at(i).gt(0) }, everyNSamples);
        output.ch(0).at(i).write(r.left); output.ch(1).at(i).write(r.right); output.ch(2).at(i).write(f32(r.ratioRejected));
      }
    }); } };
  });
}
async function render(rate: number, data: Float32Array[], width?: number, restore?: Uint8Array) {
  const result = await renderOffline(fixture(width), { sampleRate: rate, duration: (data[0].length - .25) / rate, inputs: { main: data }, restore });
  expect(result.outputs.main[0].length).toBe(data[0].length);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  expect(result.outputs.main.every(channel => channel.every(Number.isFinite))).toBe(true);
  return result;
}
function check(actual: Float32Array[], expected: Float32Array[], tolerance = 1e-6) {
  actual.forEach((channel, ch) => expect(maxError(channel, expected[ch])).toBeLessThan(tolerance));
}

for (const rate of rates) {
  test(`hybrid and feedforward impulse paths match direct FIR/tap/FDN equations ${rate}`, async () => {
    const data = ports(8192, { 0: n => Number(n === 0), 5: 1 });
    for (const width of [undefined, 512]) {
      const actual = (await render(rate, data, width)).outputs.main;
      const reference = spatialReference(data, rate, width);
      check(actual, reference.output, 2e-7);
      const first = 8 + Math.floor(rate * Math.fround(.007));
      expect(actual[0].slice(0, first).every(x => x === 0)).toBe(true);
      const earlyEnd = Math.ceil(rate * .023) + 16;
      const lateStart = Math.floor(Math.min(Math.round(rate * .0297), rate * Math.fround(Math.round(rate * .0297) / rate)));
      expect(Math.max(...actual[0].slice(earlyEnd, lateStart).map(Math.abs))).toBeLessThan(1e-12);
      if (width) expect(Math.max(...actual[0].slice(earlyEnd, lateStart + 1 + width / 2).map(Math.abs))).toBeLessThan(1e-12);
      const sum = (a: Float32Array, start: number, end: number) => a.slice(start, end).reduce((s, v) => s + v, 0);
      for (const [seconds, left, right] of [[.007, .5, .25], [.013, .25, -.25], [.023, -.125, .375]]) {
        const at = 8 + Math.floor(rate * Math.fround(seconds));
        expect(sum(actual[0], at - 1, at + 10)).toBeCloseTo(.5 * .75 * left, 6);
        expect(sum(actual[1], at - 1, at + 10)).toBeCloseTo(.5 * .75 * right, 6);
      }
    }
  });

  test(`a-rate blends, every B8 reset phase, bypass/reset priority and pitch rejection ${rate}`, async () => {
    const resetAt = new Set(Array.from({ length: 8 }, (_, p) => 8192 + 2049 * p));
    const data = ports(32768, {
      0: n => .35 * Math.sin(n * .137) + .25 * Math.cos(n * .061),
      1: n => n < 4096 ? 1 : n < 6144 ? 0 : [-1, .25, .7, 2][Math.floor(n / 257) % 4],
      2: n => Number(n >= 11000 && n < 14800 || n >= 30000 && n < 30200),
      3: n => Number(resetAt.has(n) || n >= 30101 && n < 30109),
      4: n => [2, .5, 1.375, 1, -.25, 2.25][Math.floor(n / 397) % 6],
      5: n => [-1, .25, .75, 2][Math.floor(n / 631) % 4],
      6: n => Number(n === 5301 || n >= 18000 && n < 18007 || n === 30102),
    });
    for (const width of [undefined, 512]) {
      const actual = (await render(rate, data, width)).outputs.main;
      check(actual, spatialReference(data, rate, width).output);
      for (let n = 0; n < data[0].length; n++) {
        if (data[3][n] > 0) expect(actual[0][n]).toBe(0);
        else if (data[2][n] > 0 || data[1][n] <= 0) {
          expect(actual[0][n]).toBe(data[0][n]); expect(actual[1][n]).toBe(data[0][n]);
        }
      }
      if (width) expect(actual[2]).toEqual(Float32Array.from(data[4], v => Number(v < .5 || v > 2)));
    }
  });

  test(`bypass suppresses new excitation and reveals a continuing nonzero tail ${rate}`, async () => {
    const forced = ports(16384, { 0: n => n < 4096 ? .5 * Math.sin(n * .13) : n < 8192 ? .9 : 0, 2: n => Number(n >= 4096 && n < 8192), 4: 2 });
    const silent = forced.map(x => x.slice()); silent[0].fill(0, 4096);
    for (const width of [undefined, 512]) {
      const a = (await render(rate, forced, width)).outputs.main, b = (await render(rate, silent, width)).outputs.main;
      for (let ch = 0; ch < 2; ch++) {
        expect(a[ch].slice(8192)).toEqual(b[ch].slice(8192));
        expect(a[ch].slice(8192).some(x => Math.abs(x) > 1e-5)).toBe(true);
      }
      check(a, spatialReference(forced, rate, width).output);
    }
  });

  test(`noninitial native histories and moving pitch phases restore bit-identically ${rate}`, async () => {
    const data = ports(16384, {
      0: n => n < 12000 ? .4 * Math.sin(n * .119) + .2 * Math.cos(n * .07) : 0,
      1: .75, 4: n => n < 11000 ? .625 : 1.5, 5: .625, 6: n => Number(n === 4000),
    });
    for (const width of [undefined, 512]) {
      const all = await render(rate, data, width), split = 9856;
      const first = await render(rate, data.map(x => x.slice(0, split)), width);
      const rest = await render(rate, data.map(x => x.slice(split)), width, first.state);
      expect(rest.outputs.main).toEqual(all.outputs.main.map(x => x.slice(split)));
      const buffers = decodeSnapshot(first.state).slots.filter(x => x.kind === 'buffer');
      expect(buffers).toHaveLength(width === undefined ? 11 : 13);
      expect(buffers.some(x => /earlyColor.*overlap/.test(x.name))).toBe(true);
      const clear = await render(rate, ports(4096, { 0: 1, 2: 1, 3: 1 }), width, first.state);
      expect(clear.outputs.main.slice(0, 2).every(ch => ch.every(x => x === 0))).toBe(true);
    }
  });
}

test('unpitched endpoint equals the plain hybrid; zero mix continues wet excitation', async () => {
  const data = ports(8192, { 0: n => n < 4096 ? .5 * Math.sin(n * .071) : 0, 1: n => Number(n >= 4096), 4: 2, 5: 0 });
  const plain = (await render(48000, data)).outputs.main, pitched = (await render(48000, data, 2048)).outputs.main;
  expect(pitched.slice(0, 2)).toEqual(plain);
  expect(plain[0].slice(4096).some(x => Math.abs(x) > 1e-4)).toBe(true);
});

test('the complete pitched composition retains the undersized-window cancellation counterexample', async () => {
  const data = ports(131072, { 0: n => .25 * Math.cos(2 * Math.PI * n / 128), 4: 2, 5: 1 });
  const reference = spatialReference(data, 48000, 64);
  const actual = (await render(48000, data, 64)).outputs.main;
  check(actual, reference.output);
  const start = 98304;
  // Remove the independently computed early path to observe only the actual
  // feedforward late reader. Its W64 phase repeats every 64 samples, whereas
  // this carrier changes sign over 64: doubled-frequency content cancels.
  const shifted = Float32Array.from(actual[0].slice(start), (x, n) => 2 * x - reference.early[0][start + n]);
  expect(complexBin(shifted, 1 / 64).magnitude).toBeLessThan(2e-7);
  expect(complexBin(shifted, 1 / 128).magnitude).toBeGreaterThan(1e-4);
  expect(complexBin(reference.late[0].slice(start), 1 / 128).magnitude).toBeGreaterThan(1e-4);
});

test('construction bounds validate exact public rates and pitch windows', () => {
  const plain = (config: SpatialChainConfig) => defineProcessor(() => { instantiate(hybridReverb, config, { name: 'x' }); return { process() {} }; });
  const pitched = (config: FeedforwardPitchedReverbConfig) => defineProcessor(() => { instantiate(feedforwardPitchedReverb, config, { name: 'x' }); return { process() {} }; });
  for (const sampleRate of [NaN, Infinity, 7999, 192001, 48000.5]) {
    expect(() => plain({ sampleRate })).toThrow(RangeError); expect(() => pitched({ sampleRate })).toThrow(RangeError);
  }
  for (const windowSamples of [NaN, Infinity, 31, 33, 16385, 16386]) expect(() => pitched({ sampleRate: 48000, windowSamples })).toThrow(RangeError);
  for (const sampleRate of [8000, 8001, 192000]) {
    expect(() => plain({ sampleRate })).not.toThrow();
    for (const windowSamples of [undefined, 32, 16384]) expect(() => pitched({ sampleRate, windowSamples })).not.toThrow();
  }
});

for (const [rate, width] of [[8000, 32], [44100, 512], [48000, 512], [96000, 512], [192000, 16384]]) {
  test(`native fixed capacity, normalized input and scratch independence ${rate}/W${width}`, async () => {
    const compiled = await compile(fixture(width), { sampleRate: rate });
    const driver = await compiled.driver.instantiate(), twin = await compiled.driver.instantiate();
    const memoryBytes = driver.memory.buffer.byteLength;
    const data = ports(32768, {
      0: n => n < 12000 ? (n % 257 < 128 ? 1 : -1) : 0,
      4: n => n < 16000 ? .75 : 2, 5: .75,
    });
    const expected = spatialReference(data, rate, width).output;
    const observed = expected.map(x => new Float32Array(x.length));
    // Deliberately clone native memory once, then poison only declared transient
    // temporaries. This is a scratch-dependence probe; real snapshot continuation
    // is separately tested above with the public encode/restore path.
    const regions = (compiled.memory as unknown as { regions: {
      states: { slots: Record<string, number> };
      buffers: { slots: Record<string, number>; lengths: Record<string, number> };
    } }).regions;
    const split = 9856, timings: number[] = [];
    let poisonedStates = 0, poisonedBuffers = 0;
    for (let offset = 0; offset < data[0].length; offset += 128) {
      if (offset === split) {
        new Uint8Array(twin.memory.buffer).set(new Uint8Array(driver.memory.buffer));
        const view = new DataView(twin.memory.buffer);
        for (const [name, at] of Object.entries(regions.states.slots)) {
          if (/\/(wet[0-3]|wetLeft|wetRight|wetScaled|twiddleReal|twiddleImag)$/.test(name)) {
            view.setFloat64(at, poisonedStates % 2 ? -1e90 : 1e90, true); poisonedStates++;
          } else if (name.endsWith('/feed')) { view.setFloat32(at, 1e10, true); poisonedStates++; }
        }
        for (const [name, at] of Object.entries(regions.buffers.slots)) if (/\/(mixedReal|mixedImag|real[01]|imag[01])$/.test(name)) {
          for (let n = 0; n < regions.buffers.lengths[name]; n++) view.setFloat64(at + 8 * n, n % 2 ? -1e90 : 1e90, true);
          poisonedBuffers++;
        }
      }
      for (let ch = 0; ch < data.length; ch++) {
        driver.writeInput('main', ch, data[ch].slice(offset, offset + 128));
        if (offset >= split) twin.writeInput('main', ch, data[ch].slice(offset, offset + 128));
      }
      const start = performance.now(); driver.process(); timings.push(performance.now() - start);
      if (offset >= split) twin.process();
      for (let ch = 0; ch < observed.length; ch++) {
        const block = new Float32Array(128); driver.readOutput('main', ch, block); observed[ch].set(block, offset);
        if (offset >= split) { const paired = block.slice(); twin.readOutput('main', ch, paired); expect(paired).toEqual(block); }
      }
    }
    check(observed, expected, 2e-6);
    expect(observed.every(ch => ch.every(Number.isFinite))).toBe(true);
    expect(poisonedStates).toBe(11); expect(poisonedBuffers).toBe(6);
    expect(driver.scrubbedSamples()).toBe(0); expect(twin.scrubbedSamples()).toBe(0);
    expect(driver.memory.buffer.byteLength).toBe(memoryBytes); expect(twin.memory.buffer.byteLength).toBe(memoryBytes);
    const warm = timings.slice(1).sort((a, b) => a - b);
    console.log(JSON.stringify({ sampleRate: rate, windowSamples: width, memoryBytes, wasmBytes: compiled.wasm.byteLength,
      maxOracleError: Math.max(...observed.map((x, ch) => maxError(x, expected[ch]))), poisonedStates, poisonedBuffers,
      coldQuantumMs: timings[0], warmP50Ms: warm[Math.floor(warm.length / 2)], warmMaxMs: warm.at(-1),
      quantumBudgetMs: 128000 / rate, deadlineMisses: timings.filter(ms => ms > 128000 / rate).length,
      status: 'CANDIDATE / NOT_CLEARED; local native diagnostic, no realtime claim' }));
  });
}
