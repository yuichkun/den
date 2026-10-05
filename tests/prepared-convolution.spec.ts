import { afterAll, expect, test } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { audioInput, audioOutput, CAPACITY_16, decodeSnapshot, encodeScalar, encodeSnapshot, event, f32, forSample, inspect, instantiate, defineProcessor, select } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { preparedConvolution, prepareConvolutionSpectrum, type PreparedConvolutionPacket } from '../src/prepared-convolution.js';

const config = { blockSize: 128, partitions: 64 }, B = 128;
const reports: object[] = [];
afterAll(() => { mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/prepared-convolution-numerics.json', JSON.stringify({ status: 'CANDIDATE', reports }, null, 2)); });
const fixture = () => defineProcessor(() => {
  const input = audioInput({ channels: 2, name: 'main' }), output = audioOutput({ channels: 4, name: 'main' });
  const convolution = instantiate(preparedConvolution, config, { name: 'convolution' });
  const load = event<PreparedConvolutionPacket>({ from: 'main', name: 'ir', capacity: CAPACITY_16, payloadCapacity: 131072 });
  load.onReceive(packet => convolution.load(packet));
  return { process() { forSample((i, everyNSamples) => {
    const r = convolution.tick(input.ch(0).at(i), input.ch(1).at(i).gt(0), everyNSamples);
    [r.output, select(r.loaded, f32(1), f32(0)), select(r.rejected, f32(1), f32(0)), f32(r.revision)].forEach((value, ch) => output.ch(ch).at(i).write(value));
  }); } };
}, { id: 'den.prepared-convolution.test.v1' });
const processor = fixture();
type Load = { atQuantum: number; payload: PreparedConvolutionPacket; impulse: readonly number[] | null; rejected?: boolean };
const render = (rate: number, input: Float32Array, reset: Float32Array, loads: Load[], restore?: Uint8Array) =>
  renderOffline(processor, { sampleRate: rate, duration: (input.length - 0.25) / rate, inputs: { main: [input, reset] }, messages: loads.map(load => ({ name: 'ir', atQuantum: load.atQuantum, payload: load.payload })), restore });
function directAt(input: Float32Array, impulse: readonly number[], sample: number, start: number) {
  let value = 0;
  for (let k = 0; k < impulse.length; k++) if (sample - B - k >= start) value += input[sample - B - k] * impulse[k];
  return value;
}
// Test-only direct inverse DFT, independent of the production FFT and host
// preparation. Retain the reconstructed padded half rather than treating it as
// zero: Float32 spectrum quantization produces bounded circular leakage there.
function reconstructedPacket(packet: PreparedConvolutionPacket) {
  return Array.from({ length: 64 }, (_, p) => Float64Array.from({ length: 256 }, (_, n) => {
    let value = 0;
    for (let k = 0; k < 256; k++) {
      const phase = 2 * Math.PI * k * n / 256, index = 2 * (p * 256 + k);
      value += packet.spectrum[index] * Math.cos(phase) - packet.spectrum[index + 1] * Math.sin(phase);
    }
    return value / 256;
  }));
}
function quantizedAt(input: Float32Array, partition: Float64Array[], sample: number) {
  if (sample < B) return 0;
  const frame = Math.floor((sample - B) / B), phase = (sample - B) % B;
  let value = 0;
  for (let p = 0; p < 64; p++) for (let r = 0; r < B; r++) {
    const current = (frame - p) * B + r, previous = current - B;
    if (current >= 0) value += input[current] * partition[p][(phase - r + 256) % 256];
    if (previous >= 0) value += input[previous] * partition[p][(phase + B - r + 256) % 256];
  }
  return value;
}
function checkTimeline(output: Float32Array[], input: Float32Array, reset: Float32Array, loads: Load[], exhaustive = false) {
  let impulse: readonly number[] | null = null, start = 0, revision = 0, rejected = false, maximum = 0;
  for (let n = 0; n < input.length; n++) {
    if (n % 128 === 0) for (const load of loads.filter(load => load.atQuantum === n / 128)) { impulse = load.impulse; start = n; revision++; rejected = load.rejected ?? false; }
    if (reset[n]) start = n + 1;
    if (!impulse || exhaustive || n % 127 === 0 || n < 512 || Math.abs(n - start - B) < 140) {
      const expected = impulse ? directAt(input, impulse, n, start) : 0;
      maximum = Math.max(maximum, Math.abs(output[0][n] - expected));
    }
    if (output[1][n] !== Number(!!impulse) || output[2][n] !== Number(rejected) || output[3][n] !== revision) throw new Error(`status mismatch at sample ${n}`);
  }
  expect(maximum).toBeLessThan(5e-6);
  return maximum;
}
const unload = (): PreparedConvolutionPacket => ({ formatVersion: 1, blockSize: 128, partitions: 64, impulseFrames: 0, declaredValues: 0, spectrum: new Float32Array() });
const edgeIR = Array.from({ length: 8192 }, (_, n) => [0, 127, 128, 8191].includes(n) ? 0.75 : 0);
const edgePacket = prepareConvolutionSpectrum(edgeIR, config);
const shortIR = [0.5, -0.25, 0.125], shortPacket = prepareConvolutionSpectrum(shortIR, config);

for (const rate of [44100, 48000, 96000]) {
  test(`prepared native convolution full impulse and all partition edges at ${rate}`, async () => {
    const frames = 10240;
    for (const phase of [0, 1, 63, 127]) {
      const input = new Float32Array(frames); input[phase] = 1;
      const result = await render(rate, input, new Float32Array(frames), [{ atQuantum: 0, payload: edgePacket, impulse: edgeIR }]);
      let error = 0;
      for (let n = 0; n < frames; n++) error = Math.max(error, Math.abs(result.outputs.main[0][n] - (edgeIR[n - B - phase] ?? 0)));
      expect(error).toBeLessThan(5e-6); expect(result.diagnostics.scrubbedSamples).toBe(0);
    }
  }, 60000);

  test(`prepared convolution reset, rejected NaN, unload and shorter replacement at ${rate}`, async () => {
    const frames = 45568, input = Float32Array.from({ length: frames }, (_, n) => 0.35 * Math.sin(n * 0.0731) + 0.25 * Math.cos(n * 0.319));
    const reset = new Float32Array(frames);
    // Start after the last replacement so every one of the 128 reset offsets
    // exercises a loaded convolver; 257 samples leave output between resets.
    for (let phase = 0; phase < B; phase++) reset[12288 + phase * 257 + 255] = 1;
    reset.fill(1, 6143, 6148);
    const bad = { ...edgePacket, spectrum: edgePacket.spectrum.slice() }; bad.spectrum[bad.spectrum.length - 1] = NaN;
    const loads: Load[] = [
      { atQuantum: 0, payload: edgePacket, impulse: edgeIR },
      { atQuantum: 16, payload: bad, impulse: null, rejected: true },
      { atQuantum: 24, payload: unload(), impulse: null },
      { atQuantum: 32, payload: shortPacket, impulse: shortIR },
      { atQuantum: 80, payload: edgePacket, impulse: edgeIR },
      { atQuantum: 80, payload: shortPacket, impulse: shortIR },
    ];
    const result = await render(rate, input, reset, loads);
    checkTimeline(result.outputs.main, input, reset, loads);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
    for (const split of [2048, 2176, 3072, 4096, 4224, 6144, 8192, 12544]) {
      const first = await render(rate, input.slice(0, split), reset.slice(0, split), loads.filter(load => load.atQuantum < split / B));
      const remaining = loads.filter(load => load.atQuantum >= split / B).map(load => ({ ...load, atQuantum: load.atQuantum - split / B }));
      const continuation = await render(rate, input.slice(split), reset.slice(split), remaining, first.state);
      expect(continuation.outputs.main).toEqual(result.outputs.main.map(channel => channel.slice(split)));
      expect(continuation.diagnostics.scrubbedSamples).toBe(0);
    }
    reports.push({ sampleRate: rate, resetOffsets: 128, resetSpacing: 257, snapshotContinuations: 8, malformedUnloadShortSequence: true });
  }, 60000);

  test(`prepared convolution dense FIR oracle and superposition at ${rate}`, async () => {
    let seed = 7919;
    const raw = Array.from({ length: 8192 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 31 - 1; });
    const norm = raw.reduce((sum, value) => sum + Math.abs(value), 0), impulse = raw.map(value => value * 3.9 / norm);
    const packet = prepareConvolutionSpectrum(impulse, config), loads = [{ atQuantum: 0, payload: packet, impulse }];
    const frames = 12288, zero = new Float32Array(frames);
    const a = Float32Array.from({ length: frames }, (_, n) => Math.sin(n * 0.0937) * 0.25), b = Float32Array.from({ length: frames }, (_, n) => Math.cos(n * 0.217) * 0.25);
    const sum = Float32Array.from(a, (value, n) => value + b[n]);
    const ar = await render(rate, a, zero, loads), br = await render(rate, b, zero, loads), combined = await render(rate, sum, zero, loads);
    const originalFirError = checkTimeline(combined.outputs.main, sum, zero, loads);
    const quantized = reconstructedPacket(packet);
    let runtimeError = 0;
    for (let n = 0; n < frames; n += 127) runtimeError = Math.max(runtimeError, Math.abs(combined.outputs.main[0][n] - quantizedAt(sum, quantized, n)));
    expect(runtimeError).toBeLessThan(1e-6);
    let linearity = 0;
    for (let n = 0; n < frames; n++) linearity = Math.max(linearity, Math.abs(combined.outputs.main[0][n] - ar.outputs.main[0][n] - br.outputs.main[0][n]));
    expect(linearity).toBeLessThan(1e-6);
    for (const result of [ar, br, combined]) expect(result.diagnostics.scrubbedSamples).toBe(0);
    reports.push({ sampleRate: rate, taps: impulse.length, originalFirError, nativeVsQuantizedOperatorError: runtimeError, superpositionError: linearity });
  }, 60000);

  test(`prepared convolution steady complex transfer at ${rate}`, async () => {
    const frames = 10240, zero = new Float32Array(frames);
    for (const omega of [2 * Math.PI * 7 / 256, 0.713]) {
      const real = Float32Array.from({ length: frames }, (_, n) => 0.5 * Math.cos(omega * n));
      const imag = Float32Array.from({ length: frames }, (_, n) => 0.5 * Math.sin(omega * n));
      const loads = [{ atQuantum: 0, payload: edgePacket, impulse: edgeIR }];
      const rr = await render(rate, real, zero, loads), ri = await render(rate, imag, zero, loads);
      let hr = 0, hi = 0, error = 0;
      for (let k = 0; k < edgeIR.length; k++) { hr += edgeIR[k] * Math.cos(-omega * k); hi += edgeIR[k] * Math.sin(-omega * k); }
      for (let n = 8448; n < frames; n++) {
        const phase = omega * (n - B), c = Math.cos(phase) * 0.5, s = Math.sin(phase) * 0.5;
        error = Math.max(error, Math.hypot(rr.outputs.main[0][n] - (hr * c - hi * s), ri.outputs.main[0][n] - (hr * s + hi * c)));
      }
      expect(error).toBeLessThan(5e-6); expect(rr.diagnostics.scrubbedSamples + ri.diagnostics.scrubbedSamples).toBe(0);
      reports.push({ sampleRate: rate, angularFrequency: omega, complexTransferError: error });
    }
  }, 60000);
}

test('native normalized DC gain, signed subnormal input, missing asset and wrapped i32 revision', async () => {
  const frames = 2048, rate = 48000, zero = new Float32Array(frames), identity = prepareConvolutionSpectrum([1], config);
  const missing = await render(rate, new Float32Array(frames).fill(1), zero, []);
  expect(missing.outputs.main[0].every(value => value === 0)).toBe(true);
  for (const amplitude of [2 ** -149, 2 ** -130, 1e-29, 0.5, 1]) {
    const input = Float32Array.from({ length: frames }, (_, n) => amplitude * (n % 3 ? 1 : -1));
    const result = await render(rate, input, zero, [{ atQuantum: 0, payload: identity, impulse: [1] }]);
    for (let n = B; n < frames; n++) expect(result.outputs.main[0][n]).toBe(input[n - B]);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
  for (const amplitude of [1e-30, 1e-40, 1e-46, 1e-50]) {
    const packet = prepareConvolutionSpectrum([amplitude], config), input = new Float32Array(frames); input[0] = 1;
    const result = await render(rate, input, zero, [{ atQuantum: 0, payload: packet, impulse: [amplitude] }]);
    expect(result.outputs.main[0][B]).toBe(Math.fround(amplitude));
    for (let n = 0; n < frames; n++) if (n !== B) expect(Math.abs(result.outputs.main[0][n])).toBeLessThanOrEqual(2 ** -149);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
  const gainIR = [1, 1, 1, 1], gain = await render(rate, new Float32Array(frames).fill(1), zero, [{ atQuantum: 0, payload: prepareConvolutionSpectrum(gainIR, config), impulse: gainIR }]);
  expect(gain.outputs.main[0].slice(256).every(value => Math.abs(value - 4) < 5e-6)).toBe(true);
  const snapshot = decodeSnapshot(missing.state);
  const changed = encodeSnapshot(snapshot.schemaHash, snapshot.profile, snapshot.slots.map(slot => slot.name === 'convolution/revision' ? { ...slot, data: encodeScalar('i32', 2147483646) } : slot), snapshot.processorId);
  const wrapped = await render(rate, zero, zero, [{ atQuantum: 0, payload: identity, impulse: [1] }, { atQuantum: 0, payload: unload(), impulse: null }], changed);
  expect(inspect(wrapped.state).slots['convolution/revision']).toMatchObject({ kind: 'state', type: 'i32', value: -2147483648 });
  expect(wrapped.outputs.main[0].every(value => value === 0)).toBe(true); expect(wrapped.diagnostics.scrubbedSamples).toBe(0);
}, 60000);

test('host preparation rejects malformed IR/configuration without normalization', () => {
  for (const ir of [[], new Array(3), [NaN], [Infinity], [1.01], [1, 1, 1, 1, 0.01], Array(8193).fill(0)]) expect(() => prepareConvolutionSpectrum(ir, config)).toThrow(RangeError);
  for (const invalid of [{ blockSize: 64, partitions: 64 }, { blockSize: 128, partitions: 32 }]) expect(() => prepareConvolutionSpectrum([1], invalid)).toThrow(RangeError);
  const packet = prepareConvolutionSpectrum(Float64Array.from([0.5, -0.25]), config);
  expect(packet.spectrum).toBeInstanceOf(Float32Array); expect(packet.spectrum.length).toBe(32768); expect(packet.spectrum[0]).toBe(0.25);
  expect(packet).toMatchObject({ formatVersion: 1, blockSize: 128, partitions: 64, impulseFrames: 2, declaredValues: 32768 });
});
