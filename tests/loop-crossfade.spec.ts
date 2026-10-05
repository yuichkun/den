import { expect, test } from 'vitest';
import { audioInput, audioOutput, bool, CAPACITY_16, compile, decodeSnapshot, defineProcessor, encodeScalar, encodeSnapshot, event, f32, f64, i32, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { crossfadedLoopPlayer, type CrossfadedLoopConfig } from '../src/loop-crossfade.js';
import { residentSample, samplePlayer } from '../src/sample.js';
import { loopReference, type LoopRow } from './fixtures/loop-crossfade-reference.js';
const rates = [44100, 48000, 96000], duration = (frames: number, rate: number) => (frames - .25) / rate;
const defaults: LoopRow = { gate: true, trigger: false, reset: false, rate: 1 };
const rows = (frames: number, changes: (frame: number) => Partial<LoopRow> = () => ({})) => Array.from({ length: frames }, (_, n) => ({ ...defaults, ...changes(n) }));
const controls = (data: LoopRow[]) => ['gate', 'trigger', 'reset', 'rate'].map(key => Float32Array.from(data, x => Number(x[key as keyof LoopRow])));
function processor(hostRate: number, sourceRate = hostRate, options: Partial<CrossfadedLoopConfig> = {}, capacity = 16) {
  return defineProcessor(() => {
    const sample = instantiate(residentSample, { capacity, sourceSampleRate: sourceRate }, { name: 'asset' });
    const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: capacity * 4 });
    load.onReceive(x => sample.load(x.data));
    const player = instantiate(crossfadedLoopPlayer, { sampleRate: hostRate, sample, crossfadeFrames: Math.floor(capacity / 4), ...options }, { name: 'player' });
    const input = audioInput({ channels: 4, name: 'controls' }), output = audioOutput({ channels: 7, name: 'main' });
    return { process() { forSample(i => {
      const result = player.tick({ gate: input.ch(0).at(i).gt(0), trigger: input.ch(1).at(i).gt(0), reset: input.ch(2).at(i).gt(0), rate: input.ch(3).at(i) });
      [result.output, f32(result.active), result.position, result.phase, f32(result.periodFrames), f32(result.crossfadeFrames), f32(result.missing)].forEach((x, ch) => output.ch(ch).at(i).write(x));
    }); } };
  });
}
function check(actual: Float32Array[], expected: number[][], tolerance = 4e-6) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((channel, ch) => { expect(channel.length).toBe(expected[ch].length); let error = 0;
    channel.forEach((value, n) => { expect(Number.isFinite(value)).toBe(true); error = Math.max(error, Math.abs(value - expected[ch][n])); });
    expect(error, `channel ${ch}`).toBeLessThan(tolerance);
  });
}
for (const rate of rates) {
  test(`independent slice timeline: fractional/source-rate, reverse/sign changes, release/reset/held trigger ${rate}`, async () => {
    const pcm = Float32Array.from({ length: 16 }, (_, n) => .7 * Math.sin(n * .7) + n / 32);
    const input = rows(1024, n => ({ gate: n < 720 || n >= 850, trigger: n >= 350 && n < 355 || n === 600,
      reset: n >= 510 && n < 514, rate: n < 128 ? .625 : n < 256 ? -1.25 : n < 450 ? 0 : n < 600 ? 16 : -.375 }));
    const p = processor(rate, 32000, { startFrame: 2, endFrame: 15, crossfadeFrames: 4, releaseFrames: 9 });
    const result = await renderOffline(p, { sampleRate: rate, duration: duration(input.length, rate), inputs: { controls: controls(input) }, messages: [{ name: 'load', payload: { data: pcm } }] });
    check(result.outputs.main, loopReference(pcm, rate, 32000, input, { start: 2, end: 15, crossfade: 4, release: 9 }));
    expect(result.diagnostics.scrubbedSamples).toBe(0);
    const first = await renderOffline(p, { sampleRate: rate, duration: duration(384, rate), inputs: { controls: controls(input.slice(0, 384)) }, messages: [{ name: 'load', payload: { data: pcm } }] });
    const rest = await renderOffline(p, { sampleRate: rate, duration: duration(input.length - 384, rate), inputs: { controls: controls(input.slice(384)) }, restore: first.state });
    expect(rest.outputs.main).toEqual(result.outputs.main.map(ch => ch.slice(384)));
  });
  test(`replacement/missing/short slices reduce overlap and never restart a held gate ${rate}`, async () => {
    const initial = Float32Array.from({ length: 16 }, (_, n) => n + 1), short = Float32Array.of(90, .25, -.5, .75), one = Float32Array.of(90, -.25);
    const input = rows(768, n => ({ trigger: n === 129 || n === 256 || n === 513, rate: -.75 }));
    const replacements = [{ frame: 128, pcm: short }, { frame: 256, pcm: one }, { frame: 384, pcm: new Float32Array() }, { frame: 512, pcm: initial }];
    const result = await renderOffline(processor(rate, rate, { startFrame: 1, endFrame: 14, crossfadeFrames: 6 }), { sampleRate: rate, duration: duration(768, rate), inputs: { controls: controls(input) }, messages: [{ name: 'load', payload: { data: initial } }, ...replacements.map(x => ({ name: 'load', payload: { data: x.pcm }, atQuantum: x.frame / 128 }))] });
    check(result.outputs.main, loopReference(initial, rate, rate, input, { start: 1, end: 14, crossfade: 6 }, replacements));
    expect(result.outputs.main[0][128]).toBe(0); expect(result.outputs.main[0][256]).toBe(-.25); expect(result.outputs.main[0][512]).toBe(0);
    expect(result.outputs.main[5][129]).toBe(1); expect(result.outputs.main[4][256]).toBe(1); expect(result.outputs.main[6][384]).toBe(1);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  });
}
test('explicit eight-frame/two-overlap forward and reverse sample periods and cyclic seam', async () => {
  const pcm = Float32Array.from({ length: 8 }, (_, n) => n);
  for (const speed of [1, -1, .5]) {
    const input = rows(128, () => ({ rate: speed }));
    const result = await renderOffline(processor(48000, 48000, { crossfadeFrames: 2 }, 8), { sampleRate: 48000, duration: duration(128, 48000), inputs: { controls: controls(input) }, messages: [{ name: 'load', payload: { data: pcm } }] });
    const period = speed === 1 ? [2, 3, 4, 5, 6, 4] : speed === -1 ? [4, 6, 5, 4, 3, 2] : [2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 5, 4, 2.875];
    expect([...result.outputs.main[0]]).toEqual(Array.from({ length: 128 }, (_, n) => period[n % period.length]));
    expect(result.outputs.main[4]).toEqual(new Float32Array(128).fill(6));
  }
});
test('both overlap endpoints converge without a hidden wrap tap; fractional last frame is held before blending', async () => {
  const pcm = Float32Array.of(1, -.2, .3, .5, -.4, .7, -.8, .9), epsilon = 2 ** -16;
  // Set phase in the first increment, then freeze. This crosses either endpoint from each side.
  for (const phase of [4 - epsilon, 4, 4 + epsilon, 6 - epsilon, 6, 6 + epsilon]) {
    const input = rows(128, n => ({ rate: n === 0 ? phase : 0 }));
    const result = await renderOffline(processor(48000, 48000, { crossfadeFrames: 2 }, 8), { sampleRate: 48000, duration: duration(128, 48000), inputs: { controls: controls(input) }, messages: [{ name: 'load', payload: { data: pcm } }] });
    check(result.outputs.main, loopReference(pcm, 48000, 48000, input, { crossfade: 2 }));
    expect(Math.abs(result.outputs.main[0][1] - (phase < 5 ? pcm[6] : pcm[2]))).toBeLessThan(.00006);
  }
});
test('short loops, zero overlap, maximum overlap and nonfinite rates/PCM are bounded', async () => {
  for (const [length, overlap] of [[1, 0], [2, 1], [3, 1], [8, 0], [8, 4]]) {
    const pcm = Float32Array.from({ length }, (_, n) => [1, NaN, -.5, Infinity, .25, -Infinity, -1, .75][n]);
    const input = rows(256, n => ({ trigger: n % 31 === 0, rate: [0, NaN, Infinity, -Infinity, .125, -.125][n % 6] }));
    const result = await renderOffline(processor(48000, 192000, { crossfadeFrames: overlap }, length), { sampleRate: 48000, duration: duration(256, 48000), inputs: { controls: controls(input) }, messages: [{ name: 'load', payload: { data: pcm } }] });
    check(result.outputs.main, loopReference(pcm, 48000, 192000, input, { crossfade: overlap })); expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
});
test('linear unity-sum crossfade preserves DC/full-finite headroom and exposes cancellation and transient attenuation', async () => {
  for (const pcm of [new Float32Array(8).fill(1), new Float32Array(8).fill(Math.fround(3.4028234663852886e38)), Float32Array.of(-1, -1, 0, 0, 0, 0, 1, 1), Float32Array.of(0, 0, 0, 0, 0, 0, 0, 1)]) {
    const input = rows(128, () => ({ rate: .25 }));
    const result = await renderOffline(processor(48000, 48000, { crossfadeFrames: 2 }, 8), { sampleRate: 48000, duration: duration(128, 48000), inputs: { controls: controls(input) }, messages: [{ name: 'load', payload: { data: pcm } }] });
    const peak = Math.max(...pcm.map(Math.abs));
    expect(result.outputs.main[0].every(x => Number.isFinite(x) && Math.abs(x) <= peak)).toBe(true);
    if (pcm.every(x => x === pcm[0])) expect(result.outputs.main[0]).toEqual(new Float32Array(128).fill(pcm[0]));
    if (pcm[0] === -1) expect(result.outputs.main[0][20]).toBe(0);
    if (pcm[7] === 1 && pcm[0] === 0) expect(Math.max(...result.outputs.main[0])).toBe(.5);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
});
test('deferred returns from independent players and resident reads cannot share phase or scratch', async () => {
  const p = defineProcessor(() => {
    const sample = instantiate(residentSample, { capacity: 8, sourceSampleRate: 48000 }, { name: 'sample' });
    const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: 32 }); load.onReceive(x => sample.load(x.data));
    const a = instantiate(crossfadedLoopPlayer, { sampleRate: 48000, sample, crossfadeFrames: 2 }, { name: 'a' });
    const b = instantiate(crossfadedLoopPlayer, { sampleRate: 48000, sample, crossfadeFrames: 1, startFrame: 2, endFrame: 6 }, { name: 'b' });
    const out = audioOutput({ channels: 5, name: 'main' });
    return { process() { forSample(i => {
      const common = { gate: bool(true), trigger: bool(false), reset: bool(false) };
      const left = a.tick({ ...common, rate: f32(.5) }), direct = sample.read(f64(7.75), i32(0), i32(8), true), right = b.tick({ ...common, rate: f32(-.25) });
      [left.output, right.output, direct, left.phase, right.position].forEach((x, ch) => out.ch(ch).at(i).write(x));
    }); } };
  });
  const pcm = Float32Array.from({ length: 8 }, (_, n) => n + 1), input = rows(256);
  const result = await renderOffline(p, { sampleRate: 48000, duration: duration(256, 48000), messages: [{ name: 'load', payload: { data: pcm } }] });
  const a = loopReference(pcm, 48000, 48000, input.map(x => ({ ...x, rate: .5 })), { crossfade: 2 });
  const b = loopReference(pcm, 48000, 48000, input.map(x => ({ ...x, rate: -.25 })), { start: 2, end: 6, crossfade: 1 });
  check(result.outputs.main, [a[0], b[0], Array(256).fill(2.75), a[3], b[2]]);
});
test('revision wrap invalidates playback and a same-tick explicit trigger reads the replacement', async () => {
  const p = processor(48000, 48000, { crossfadeFrames: 2 }, 8), input = rows(128);
  const first = await renderOffline(p, { sampleRate: 48000, duration: duration(128, 48000), inputs: { controls: controls(input) }, messages: [{ name: 'load', payload: { data: new Float32Array(8).fill(.5) } }] });
  for (const before of [2147483647, -1]) {
    const state = decodeSnapshot(first.state), revisions = state.slots.filter(x => ['asset/revision', 'player/revision'].includes(x.name)); expect(revisions).toHaveLength(2);
    revisions.forEach(x => { x.data = encodeScalar('i32', before); });
    const result = await renderOffline(p, { sampleRate: 48000, duration: duration(128, 48000), inputs: { controls: controls(rows(128, n => ({ trigger: n === 1 }))) }, restore: encodeSnapshot(state.schemaHash, state.profile, state.slots, state.processorId), messages: [{ name: 'load', payload: { data: new Float32Array(8).fill(-.25) } }] });
    expect(result.outputs.main[0][0]).toBe(0); expect(result.outputs.main[0].slice(1)).toEqual(new Float32Array(127).fill(-.25));
  }
});
test('maximum resident and overlap have bounded graph/memory with no per-tick allocation growth', async () => {
  const p = processor(48000, 192000, { crossfadeFrames: 32768 }, 65536), compiled = await compile(p, { sampleRate: 48000 });
  const driver = await compiled.driver.instantiate(), bytes = driver.memory.buffer.byteLength;
  for (let n = 0; n < 64; n++) driver.process();
  expect(driver.memory.buffer.byteLength).toBe(bytes); expect(bytes).toBeLessThan(5 * 1024 * 1024); expect(driver.scrubbedSamples()).toBe(0);
});
test('construction rejects invalid bounds without accepting fractional or nonfinite overlap', () => {
  for (const config of [{ crossfadeFrames: -1 }, { crossfadeFrames: 1.5 }, { crossfadeFrames: 9 }, { crossfadeFrames: NaN }, { crossfadeFrames: Infinity }, { startFrame: 16 }, { endFrame: 0 }, { releaseFrames: -1 }, { releaseFrames: .5 }, { sampleRate: 7999 }, { sampleRate: Infinity }]) {
    expect(() => processor(48000, 48000, config)).toThrow(RangeError);
  }
});
test('tiny local phase survives nonzero slice and overlap offsets against full finite PCM', async () => {
  const largest = Math.fround(3.4028234663852886e38), speed = 2 ** -149;
  for (const overlap of [0, 2]) {
    const pcm = new Float32Array(8); pcm[3 + overlap] = largest;
    const input = rows(128, () => ({ rate: speed }));
    const p = processor(48000, 48000, { startFrame: 2, endFrame: 6, crossfadeFrames: overlap }, 8);
    const result = await renderOffline(p, { sampleRate: 48000, duration: duration(128, 48000), inputs: { controls: controls(input) }, messages: [{ name: 'load', payload: { data: pcm } }] });
    expect(result.outputs.main[0]).toEqual(Float32Array.from({ length: 128 }, (_, n) => Math.fround(n * speed * largest)));
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
});
for (const rate of rates) test(`zero overlap matches existing samplePlayer emitted output/activity without changing its idle-phase law ${rate}`, async () => {
  const pcm = Float32Array.from({ length: 16 }, (_, n) => .7 * Math.sin(n));
  const input = rows(512, n => ({ gate: n < 250 || n >= 320, trigger: n === 140, reset: n === 400, rate: n < 128 ? .5 : n < 200 ? -1.25 : n < 360 ? 0 : 16 }));
  const p = defineProcessor(() => {
    const sample = instantiate(residentSample, { capacity: 16, sourceSampleRate: 32000 }, { name: 'sample' });
    const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: 64 }); load.onReceive(x => sample.load(x.data));
    const config = { sampleRate: rate, sample, startFrame: 2, endFrame: 15, releaseFrames: 9 };
    const old = instantiate(samplePlayer, { ...config, loop: true }, { name: 'old' }), fresh = instantiate(crossfadedLoopPlayer, { ...config, crossfadeFrames: 0 }, { name: 'fresh' });
    const audio = audioInput({ channels: 4, name: 'controls' }), out = audioOutput({ channels: 4, name: 'main' });
    return { process() { forSample(i => {
      const c = { gate: audio.ch(0).at(i).gt(0), trigger: audio.ch(1).at(i).gt(0), reset: audio.ch(2).at(i).gt(0), rate: audio.ch(3).at(i) };
      const a = old.tick(c), b = fresh.tick(c);
      [a.output, b.output, f32(a.active), f32(b.active)].forEach((value, ch) => out.ch(ch).at(i).write(value));
    }); } };
  });
  const result = await renderOffline(p, { sampleRate: rate, duration: duration(512, rate), inputs: { controls: controls(input) }, messages: [{ name: 'load', payload: { data: pcm } }] });
  check([result.outputs.main[0]], [[...result.outputs.main[1]]]); expect(result.outputs.main[2]).toEqual(result.outputs.main[3]); expect(result.diagnostics.scrubbedSamples).toBe(0);
});
for (const rate of rates) test(`snapshot captured inside the overlap resumes with no dependence on transient read scratch ${rate}`, async () => {
  const p = processor(rate, rate, { crossfadeFrames: 2 }, 8), pcm = Float32Array.from({ length: 8 }, (_, n) => n);
  const input = rows(256, n => ({ rate: n === 0 ? 4.5 : n < 128 ? 0 : -.125 }));
  const full = await renderOffline(p, { sampleRate: rate, duration: duration(256, rate), inputs: { controls: controls(input) }, messages: [{ name: 'load', payload: { data: pcm } }] });
  const first = await renderOffline(p, { sampleRate: rate, duration: duration(128, rate), inputs: { controls: controls(input.slice(0, 128)) }, messages: [{ name: 'load', payload: { data: pcm } }] });
  expect(first.outputs.main[3][127]).toBe(4.5); expect(first.outputs.main[0][127]).toBe(5);
  const slots = decodeSnapshot(first.state).slots;
  expect(slots.find(x => x.name === 'player/scaledPhase')?.data).toEqual(encodeScalar('f64', 4.5 * 2 ** 128));
  expect(slots.some(x => x.name === 'player/scaledCurrentPhase')).toBe(false);
  const rest = await renderOffline(p, { sampleRate: rate, duration: duration(128, rate), inputs: { controls: controls(input.slice(128)) }, restore: first.state });
  expect(rest.outputs.main).toEqual(full.outputs.main.map(ch => ch.slice(128)));
});
