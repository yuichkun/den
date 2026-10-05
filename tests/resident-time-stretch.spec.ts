import { test, expect } from 'vitest';
import { audioOutput, bool, CAPACITY_16, decodeScalar, decodeSnapshot, defineProcessor, event, f32, forSample, instantiate, select } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { residentSample } from '../src/sample.js';
import { residentTimeStretch, type ResidentTimeStretchConfig } from '../src/resident-time-stretch.js';
import { stretchProcessor } from './fixtures/resident-time-stretch-processor.js';
import { stretchBin, stretchMaxError, stretchPorts, stretchReference, stretchRows, type StretchLoad, type StretchRow } from './fixtures/resident-time-stretch-reference.js';
const rates = [44100, 48000, 96000];
async function render(rows: StretchRow[], loads: StretchLoad[], rate: number, sourceRate = rate, hop: 128 | 256 = 256, radius: ResidentTimeStretchConfig['searchFrames'] = 64, restore?: Uint8Array, capacity = 65536) {
  const result = await renderOffline(stretchProcessor(sourceRate, capacity, hop, radius), { sampleRate: rate, duration: (rows.length - .25) / rate, inputs: { controls: stretchPorts(rows) }, messages: loads.map(x => ({ name: 'load', payload: { data: x.data }, atQuantum: x.at / 128 })), restore });
  expect(result.outputs.main[0].length).toBe(rows.length); expect(result.diagnostics.scrubbedSamples).toBe(0);
  expect(result.outputs.main.every(c => c.every(Number.isFinite))).toBe(true); return result;
}
function compare(actual: Float32Array[], expected: Float32Array[], tolerance = 3e-7) {
  actual.forEach((c, j) => expect(stretchMaxError(c, expected[j]), `channel ${j}`).toBeLessThan(tolerance));
}
for (const rate of rates) {
  test(`WSOLA unity preserves arbitrary PCM exactly and duration/pitch have independent actual signals at ${rate}`, async () => {
    const frames = 8192, pcm = Float32Array.from({ length: frames }, (_, n) => .5 * Math.cos(2 * Math.PI * n / 128));
    for (const durationScale of [.5, 1, 2]) for (const pitchRatio of [.5, 1, 2]) {
      const total = frames * durationScale, rows = stretchRows(total + 256, () => ({ durationScale, pitchRatio }));
      const result = await render(rows, [{ at: 0, data: pcm }], rate), out = result.outputs.main;
      expect(out[1].slice(0, total).every(x => x === 1)).toBe(true); expect(out[1].slice(total).every(x => x === 0)).toBe(true);
      expect(out[3][total - 1]).toBe(0); expect(out[3][total]).toBe(1); expect(out[2][total]).toBe(frames);
      expect(out[0].slice(total).every(x => x === 0)).toBe(true);
      // Analyze only the source-supported interior. Previous grains can
      // reach ahead by up to two windows plus the bounded alignment offset.
      const boundary = Math.ceil((512 * pitchRatio + 64) * durationScale / 256) * 256;
      const middle = out[0].slice(1024, total - boundary);
      expect(stretchBin(middle, pitchRatio / 128), `duration=${durationScale}, pitch=${pitchRatio}`).toBeGreaterThan(.4998);
      if (pitchRatio !== 1) expect(stretchBin(middle, 1 / 128)).toBeLessThan(2e-6);
      // Audio, not just the active flag, reaches the stretched late region.
      expect(Math.max(...out[0].slice(total - 768, total - 512).map(Math.abs))).toBeGreaterThan(.25);
      expect(out[0].findLastIndex(x => Math.abs(x) > 1e-6)).toBeGreaterThan(total - 512);
      if (durationScale === 1 && pitchRatio === 1) expect(out[0].slice(0, frames)).toEqual(pcm);
    }
    const arbitrary = Float32Array.from({ length: 1537 }, (_, n) => .3 * Math.sin(n * .18123) + .2 * Math.cos(n * .7921));
    const result = await render(stretchRows(1792), [{ at: 0, data: arbitrary }], rate);
    expect(result.outputs.main[0].slice(0, arbitrary.length)).toEqual(arbitrary);
  });
  test(`independent scalar source clock/search, off-bin mixture and mismatched source rate at ${rate}`, async () => {
    const sourceRate = 32000, pcm = Float32Array.from({ length: 1901 }, (_, n) => .7 * Math.sin(n * .09371) + .2 * Math.cos(n * .7181));
    for (const hop of [128, 256] as const) for (const radius of [0, 8, 64, 128] as const) {
      const rows = stretchRows(4096, n => ({ durationScale: n < 1600 ? .73 : 1.81, pitchRatio: n < 1600 ? 1.37 : .57, trigger: n === 1501 || n === 3077, reset: n >= 2701 && n <= 2705 }));
      const loads = [{ at: 0, data: pcm }], result = await render(rows, loads, rate, sourceRate, hop, radius);
      compare(result.outputs.main, stretchReference(rows, loads, rate, sourceRate, hop, radius));
      expect(Math.max(...result.outputs.main[0].map(Math.abs))).toBeLessThanOrEqual(Math.max(...pcm.map(Math.abs)));
    }
  });
  test(`queued/reset/held-trigger, gate-off, delayed/short/empty replacement and exact snapshot at ${rate}`, async () => {
    const pcm = Float32Array.from({ length: 4096 }, (_, n) => .5 * Math.sin(n * .271));
    const rows = stretchRows(2048, n => ({ durationScale: 1.3, pitchRatio: .8, gate: n !== 65 && n !== 700, trigger: n === 190 || n === 321 || n >= 1001 && n < 1400, reset: n === 513 || n >= 769 && n <= 775 }));
    const loads = [{ at: 128, data: pcm }, { at: 640, data: Float32Array.of(2, -3, 1) }, { at: 1536, data: new Float32Array() }, { at: 1792, data: pcm }];
    const full = await render(rows, loads, rate), expected = stretchReference(rows, loads, rate, rate);
    compare(full.outputs.main, expected);
    // Split at 384: H=256 mid-hop, with a pending launch and live grains.
    const loaded = [{ at: 0, data: pcm }], liveRows = stretchRows(1536, n => ({ durationScale: 1.7, pitchRatio: 1.23, trigger: n === 333 }));
    const whole = await render(liveRows, loaded, rate), prefix = await render(liveRows.slice(0, 384), loaded, rate);
    const suffix = await render(liveRows.slice(384), [], rate, rate, 256, 64, prefix.state);
    expect(suffix.outputs.main).toEqual(whole.outputs.main.map(c => c.slice(384)));
    const resetRows = stretchRows(512, () => ({ reset: true })), cleared = await render(resetRows, [], rate, rate, 256, 64, prefix.state);
    expect(cleared.outputs.main[0].every(x => x === 0)).toBe(true); expect(cleared.outputs.main[4].every(x => x === 0)).toBe(true);
  });
  test(`zero-padded edges, short assets, silence/tie order, finite extremes and subnormals at ${rate}`, async () => {
    for (const data of [Float32Array.of(3), Float32Array.of(2, -1), Float32Array.of(1, NaN, Infinity, -Infinity, -.5), new Float32Array(257), new Float32Array(1024).fill(Math.fround(1e-40)), new Float32Array(1024).fill(2 ** -149), new Float32Array(1024).fill(Math.fround(3.4028234663852886e38))]) {
      const rows = stretchRows(2304, () => ({ durationScale: 1.5, pitchRatio: 1.75 })), loads = [{ at: 0, data }];
      const result = await render(rows, loads, rate, rate, 256, 8), expected = stretchReference(rows, loads, rate, rate, 256, 8);
      const maximum = Math.max(...data.filter(Number.isFinite).map(Math.abs), 1);
      result.outputs.main[0].forEach((v, n) => expect(Math.abs(v / maximum - expected[0][n] / maximum)).toBeLessThan(2e-7));
      if (data.every(x => x === 0)) expect(result.outputs.main[7].every(x => x === 0)).toBe(true);
      if (data[0] > 0 && data[0] < 1e-30) expect(result.outputs.main[0].slice(0, 256).every(x => x === data[0])).toBe(true);
    }
  });
}

test('invalid control endpoints reject only requested launches; no clamping or implicit running edits', async () => {
  const data = new Float32Array(2048).fill(.75);
  const rows = stretchRows(1792, n => ({ trigger: n % 256 === 0, durationScale: [Math.fround(.5 - 2 ** -25), .5, Math.fround(2 + 2 ** -22), 2, 1, 1, 1][Math.floor(n / 256)], pitchRatio: n >= 1280 ? 3 : 1 }));
  const result = await render(rows, [{ at: 0, data }], 48000);
  compare(result.outputs.main, stretchReference(rows, [{ at: 0, data }], 48000, 48000));
  expect(result.outputs.main[5][0]).toBe(1); expect(result.outputs.main[5][256]).toBe(0); expect(result.outputs.main[5][512]).toBe(1);
  const p = defineProcessor(ctx => {
    const sample = instantiate(residentSample, { capacity: 256, sourceSampleRate: ctx.sampleRate }, { name: 'sample' });
    const load = event<{ data: Float32Array }>({ from: 'main', name: 'load', capacity: CAPACITY_16, payloadCapacity: 1024 }); load.onReceive(x => sample.load(x.data));
    const unit = instantiate(residentTimeStretch, { sampleRate: ctx.sampleRate, sample, searchFrames: 0 }, { name: 'stretch' }), output = audioOutput({ name: 'main', channels: 2 });
    return { process() { forSample((i, everyNSamples) => { const invalid = select(i.lt(64), f32(NaN), select(i.lt(96), f32(Infinity), f32(-Infinity))); const r = unit.tick({ gate: bool(true), trigger: bool(true), reset: bool(false), durationScale: invalid, pitchRatio: invalid }, everyNSamples); output.ch(0).at(i).write(r.output); output.ch(1).at(i).write(f32(r.rejected)); }); } };
  });
  const r = await renderOffline(p, { sampleRate: 48000, duration: 512 / 48000, messages: [{ name: 'load', payload: { data: new Float32Array(256).fill(1) } }] });
  expect(r.outputs.main[0].every(x => x === 0)).toBe(true); expect(r.outputs.main[1].every(x => x === 1)).toBe(true); expect(r.diagnostics.scrubbedSamples).toBe(0);
});

test('construction bounds reject unsupported capacities/configurations', () => {
  const make = (sampleRate: number, hopSamples: number, searchFrames: number) => defineProcessor(() => {
    const sample = instantiate(residentSample, { capacity: 1, sourceSampleRate: 48000 }, { name: 'sample' });
    instantiate(residentTimeStretch, { sampleRate, sample, hopSamples, searchFrames } as ResidentTimeStretchConfig, { name: 'stretch' }); return { process() {} };
  });
  for (const rate of [NaN, Infinity, 7999, 48000.5, 192001]) expect(() => make(rate, 128, 64)).toThrow(/residentTimeStretch/);
  for (const h of [0, 64, 129, 512, NaN]) expect(() => make(48000, h, 64)).toThrow(/residentTimeStretch/);
  for (const s of [-1, 1, 7, 9, 256, NaN]) expect(() => make(48000, 128, s)).toThrow(/residentTimeStretch/);
});

test('retained linear-resampling alias and finite-window cancellation counterexamples', async () => {
  const rate = 48000, aliasPcm = Float32Array.from({ length: 8192 }, (_, n) => .5 * Math.cos(2 * Math.PI * .375 * n));
  const alias = await render(stretchRows(8448, () => ({ pitchRatio: 2 })), [{ at: 0, data: aliasPcm }], rate);
  expect(stretchBin(alias.outputs.main[0].slice(1024, 6144), .25)).toBeGreaterThan(.4998);
  expect(stretchBin(alias.outputs.main[0].slice(1024, 6144), .375)).toBeLessThan(2e-6);
  const lowPcm = Float32Array.from({ length: 4096 }, (_, n) => Math.cos(2 * Math.PI * (n - 128) / 512));
  const cancelled = await render(stretchRows(2304, () => ({ durationScale: .5 })), [{ at: 0, data: lowPcm }], rate, rate, 256, 0);
  // At n=384, equal weights mix source384(-1) and640(+1).
  expect(Math.abs(cancelled.outputs.main[0][384])).toBeLessThan(1e-7);
  expect(Math.abs(lowPcm[384])).toBeGreaterThan(.9999);
});

test('off-bin physical pitch remains independent of duration and host rate', async () => {
  const sourceRate = 32000, frequency = 437.3, pitch = 1.2, durationScale = 1.6;
  const pcm = Float32Array.from({ length: 8192 }, (_, n) => .5 * Math.sin(2 * Math.PI * frequency * n / sourceRate));
  for (const rate of rates) {
    const total = Math.ceil(pcm.length * (rate / sourceRate) * Math.fround(durationScale)), frames = Math.ceil((total + 256) / 128) * 128;
    const rendered = await render(stretchRows(frames, () => ({ durationScale, pitchRatio: pitch })), [{ at: 0, data: pcm }], rate, sourceRate, 256, 128);
    const signal = rendered.outputs.main[0].slice(2048, total - 4096), desired = frequency * Math.fround(pitch);
    let bestFrequency = 0, bestAmplitude = 0;
    for (let delta = -5; delta <= 5; delta += .25) { const f = desired + delta, a = stretchBin(signal, f / rate); if (a > bestAmplitude) { bestAmplitude = a; bestFrequency = f; } }
    expect(Math.abs(bestFrequency - desired)).toBeLessThan(.76); expect(bestAmplitude).toBeGreaterThan(.45);
    expect(rendered.outputs.main[1][total - 1]).toBe(1); expect(rendered.outputs.main[1][total]).toBe(0);
  }
});

test('opposite finite f32 extrema and varying subnormals keep the search finite and meaningful', async () => {
  const maximum = Math.fround(3.4028234663852886e38), tiny = 2 ** -149;
  for (const scale of [maximum, tiny * 16]) {
    const data = Float32Array.from({ length: 1024 }, (_, n) => (n * 37 % 31 - 15) / 16 * scale);
    const rows = stretchRows(1792, () => ({ durationScale: 1.37, pitchRatio: 1.71 })), loads = [{ at: 0, data }];
    const native = await render(rows, loads, 48000, 32000, 128, 128), expected = stretchReference(rows, loads, 48000, 32000, 128, 128);
    let units = 0; native.outputs.main[0].forEach((x, n) => { expect(Math.abs(x)).toBeLessThanOrEqual(Math.max(...data.map(Math.abs))); units = Math.max(units, Math.abs(x / scale - expected[0][n] / scale)); });
    expect(units).toBeLessThanOrEqual(scale === maximum ? 2e-7 : 1 / 16);
    expect(native.outputs.main[7]).toEqual(expected[7]);
    expect(native.outputs.main[0].some(x => x !== 0)).toBe(true);
  }
});

test('extreme source/output rate ratios retain exact short EOF and safe padded reads', async () => {
  const pcm = Float32Array.from({ length: 513 }, (_, n) => n === 0 ? .5 : -.3 * Math.sin(n));
  for (const [rate, sourceRate] of [[8000, 192000], [192000, 8000]]) {
    const rows = stretchRows(2048, () => ({ durationScale: .5, pitchRatio: 2 })), loads = [{ at: 0, data: pcm }];
    const native = await render(rows, loads, rate, sourceRate, 128, 128), expected = stretchReference(rows, loads, rate, sourceRate, 128, 128);
    compare(native.outputs.main, expected);
    if (rate === 8000) { expect(native.outputs.main[1][10]).toBe(1); expect(native.outputs.main[1][11]).toBe(0); }
  }
});

test('exact rational duration: 147-frame divisibility and f32 neighbor boundaries', async () => {
  const cases = [
    [147, 48000, 44100, .5, 80], [147, 48000, 44100, 1, 160], [147, 48000, 44100, 2, 320],
    [147, 48000, 44100, Math.fround(1 - 2 ** -24), 160], [147, 48000, 44100, Math.fround(1 + 2 ** -23), 161],
    [147, 48000, 44100, Math.fround(.5 + 2 ** -24), 81], [147, 48000, 44100, Math.fround(2 - 2 ** -23), 320],
    [320, 44100, 48000, .5, 147], [320, 44100, 48000, 1, 294], [320, 44100, 48000, 2, 588],
    [160, 96000, 48000, Math.fround(1 + 2 ** -23), 321],
  ];
  for (const [length, rate, sourceRate, durationScale, exact] of cases) {
    const frames = Math.ceil((exact + 128) / 128) * 128, pcm = new Float32Array(length).fill(.5);
    const r = await render(stretchRows(frames, () => ({ durationScale })), [{ at: 0, data: pcm }], rate, sourceRate, 128, 0);
    expect(r.outputs.main[1].reduce((a, b) => a + b, 0), `${length}/${sourceRate} at ${rate}, D${durationScale}`).toBe(exact);
    expect(r.outputs.main[3][exact - 1]).toBe(0); expect(r.outputs.main[3][exact]).toBe(1); expect(r.outputs.main[0].slice(exact).every(x => x === 0)).toBe(true);
    expect(r.outputs.main[2][exact]).toBe(length);
  }
});

test('exact count arithmetic agrees with BigInt at broad maximum-length boundaries', async () => {
  // These native renders exercise the maximum intermediate products, not a
  // duplicate implementation helper; only observe the module's nominal position.
  for (const [length, rate, sourceRate, durationScale] of [[65535, 192000, 8000, Math.fround(1.99999988)], [65536, 192000, 191999, Math.fround(1.234567)], [65533, 191999, 8001, Math.fround(.50000006)], [65536, 48000, 44100, 1]]) {
    const d = Math.fround(durationScale), numerator = BigInt(length) * BigInt(rate) * BigInt(d * 2 ** 24), denominator = BigInt(sourceRate) * 16777216n;
    const exact = Number((numerator + denominator - 1n) / denominator);
    const r = await render(stretchRows(128, () => ({ durationScale: d })), [{ at: 0, data: new Float32Array(length).fill(.5) }], rate, sourceRate, 128, 0);
    const totalSlot = decodeSnapshot(r.state).slots.find(slot => slot.name === 'stretch/total');
    expect(totalSlot).toBeDefined(); expect(decodeScalar('i32', totalSlot!.data)).toBe(exact);
    expect(r.outputs.main[2][1]).toBe(Math.fround(length / exact)); expect(r.outputs.main[2][127]).toBe(Math.fround(127 * length / exact));
  }
});

test('fractional resident source rates are rejected only by the exact-duration module', () => {
  expect(() => defineProcessor(() => {
    const sample = instantiate(residentSample, { capacity: 1, sourceSampleRate: 44100.5 }, { name: 'sample' });
    instantiate(residentTimeStretch, { sampleRate: 48000, sample }, { name: 'stretch' }); return { process() {} };
  })).toThrow(/sourceSampleRate/);
});

test('retains the sparse-WSOLA dominant-frequency deviation found by independent review', async () => {
  const rate = 44100, sourceRate = 32000, length = 16384, frequency = 997.13, pitchRatio = 1.25, durationScale = 1.75;
  const total = 39514, frames = 39680, pcm = Float32Array.from({ length }, (_, n) => Math.sin(2 * Math.PI * frequency * n / sourceRate));
  const r = await render(stretchRows(frames, () => ({ durationScale, pitchRatio })), [{ at: 0, data: pcm }], rate, sourceRate, 128, 128);
  const signal = r.outputs.main[0].slice(2048, total - 4096), windowed = Float64Array.from(signal, (x, n) => x * (.5 - .5 * Math.cos(2 * Math.PI * n / (signal.length - 1))));
  const desired = frequency * pitchRatio; let bestFrequency = 0, amplitude = 0;
  for (let delta = -4; delta <= 4; delta += .25) { const f = desired + delta, value = stretchBin(windowed, f / rate); if (value > amplitude) { amplitude = value; bestFrequency = f; } }
  expect(bestFrequency - desired).toBeGreaterThan(1.2); expect(bestFrequency - desired).toBeLessThan(2.3); expect(amplitude).toBeGreaterThan(.45);
  expect(r.outputs.main[1][total - 1]).toBe(1); expect(r.outputs.main[1][total]).toBe(0);
});
