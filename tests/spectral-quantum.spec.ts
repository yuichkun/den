import { expect, test } from 'vitest';
import { audioInput, audioOutput, CAPACITY_16, defineProcessor, event, forSample, instantiate, type CompiledProcessor } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { partitionedConvolution } from '../src/convolution.js';
import { preparedConvolution, prepareConvolutionSpectrum, type PreparedConvolutionPacket } from '../src/prepared-convolution.js';
import { stftIdentity } from '../src/spectral.js';
import { spectralFreeze } from '../src/spectral-freeze.js';
import { spectralGate } from '../src/spectral-gate.js';
import { spectralBlur, spectralCrossSynthesis } from '../src/spectral-texture.js';
import { directFreezeWola } from './spectral-freeze-consumer/oracle.mjs';
import { directGateWola } from './spectral-gate-consumer/oracle.mjs';
import { directTextureWola, maxError } from './spectral-texture-oracle.mjs';
import { stretchProcessor } from './fixtures/resident-time-stretch-processor.js';
import { stretchPorts, stretchReference, stretchRows } from './fixtures/resident-time-stretch-reference.js';

const frames = 2048, size = 256, hopSize = 128;
const taps = [0.5, -0.25, 0.125, ...Array<number>(29).fill(0), 0.25];
const preparedConfig = { blockSize: 128, partitions: 64 };
const packet = prepareConvolutionSpectrum(taps, preparedConfig);
const channels = ['identity', 'blur', 'cross', 'freeze', 'gate', 'convolution', 'prepared'];
const input = [
  Float32Array.from({ length: frames }, (_, n) => 0.3 * Math.sin(n * 0.173) + 0.2 * Math.cos(n * 0.417) + (n % 137 === 0 ? 0.25 : 0)),
  Float32Array.from({ length: frames }, (_, n) => 0.27 * Math.cos(n * 0.231) - 0.2 * Math.sin(n * 0.079)),
  Float32Array.from({ length: frames }, (_, n) => n < 767 ? 0.7 : n < 1151 ? 1 : 0.3),
  Float32Array.from({ length: frames }, (_, n) => Number(n === 127 || n === 513 || n === 514 || n === 899)),
  Float32Array.from({ length: frames }, (_, n) => Number(n >= 256 && n < 769 || n >= 1024 && n < 1667)),
  Float32Array.from({ length: frames }, (_, n) => n < 1023 ? 0.12 : 0.25),
  new Float32Array(frames).fill(0.15),
];

function processor() {
  return defineProcessor(ctx => {
    const ports = audioInput({ name: 'main', channels: input.length });
    const output = audioOutput({ name: 'main', channels: channels.length });
    const config = { size, hopSize, renderQuantumSize: ctx.renderQuantumSize };
    const identity = instantiate(stftIdentity, config, { name: 'identity' });
    const blur = instantiate(spectralBlur, { ...config, radius: 3 }, { name: 'blur' });
    const cross = instantiate(spectralCrossSynthesis, { ...config, maxGain: 4 }, { name: 'cross' });
    const freeze = instantiate(spectralFreeze, config, { name: 'freeze' });
    const gate = instantiate(spectralGate, config, { name: 'gate' });
    const convolution = instantiate(partitionedConvolution, { blockSize: 32, impulse: taps, renderQuantumSize: ctx.renderQuantumSize }, { name: 'convolution' });
    const prepared = instantiate(preparedConvolution, { ...preparedConfig, renderQuantumSize: ctx.renderQuantumSize }, { name: 'prepared' });
    const load = event<PreparedConvolutionPacket>({ from: 'main', name: 'ir', capacity: CAPACITY_16, payloadCapacity: 131072 });
    load.onReceive(value => prepared.load(value));
    return { process() { forSample((i, every) => {
      const signal = ports.ch(0).at(i), modulator = ports.ch(1).at(i), amount = ports.ch(2).at(i);
      const reset = ports.ch(3).at(i).gt(0), hold = ports.ch(4).at(i).gt(0);
      const values = [
        identity.tick(signal, reset, every),
        blur.tick(signal, amount, reset, every),
        cross.tick(signal, modulator, amount, reset, every),
        freeze.tick(signal, hold, reset, every),
        gate.tick(signal, ports.ch(5).at(i), ports.ch(6).at(i), reset, every),
        convolution.tick(signal, reset, every),
        prepared.tick(signal, reset, every).output,
      ];
      values.forEach((value, ch) => output.ch(ch).at(i).write(value));
    }); } };
  });
}

function fir(latency: number) {
  const result = new Float64Array(frames); let start = 0;
  for (let n = 0; n < frames; n++) {
    if (input[3][n]) start = n + 1;
    for (let k = 0; k < taps.length; k++) if (n - latency - k >= start) result[n] += input[0][n - latency - k] * taps[k];
  }
  return result;
}

// Reuse the independent time-indexed DFT/WOLA and scalar FIR oracles. These
// expectations do not depend on any quantum length or native scheduler phase.
const textureInput = input.slice(0, 4);
const expected = [
  directFreezeWola(input[0], input[3], new Float32Array(frames), size, hopSize, 'shift'),
  directTextureWola(textureInput, size, hopSize, 'blur', 3),
  directTextureWola(textureInput, size, hopSize, 'cross', 4),
  directFreezeWola(input[0], input[3], input[4], size, hopSize),
  directGateWola(input[0], input[3], input[5], input[6], size, hopSize),
  fir(32), fir(128),
];

function render(p: CompiledProcessor, rate: number, quantum: number, data = input, restore?: Uint8Array) {
  return renderOffline(p, {
    sampleRate: rate, renderQuantumSize: quantum, duration: (data[0].length - 0.25) / rate,
    inputs: { main: data }, restore,
    messages: restore ? [] : [{ name: 'ir', atQuantum: 0, payload: packet }],
  });
}

for (const rate of [44100, 48000, 96000]) {
  test(`spectral family matches independent oracles and quantum-128 PCM at ${rate} Hz`, async () => {
    const p = processor(), reference = await render(p, rate, 128);
    for (const quantum of [128, 32, 256]) {
      const result = quantum === 128 ? reference : await render(p, rate, quantum);
      expect(result.diagnostics.scrubbedSamples).toBe(0);
      result.outputs.main.forEach((values, ch) => {
        expect(values.length).toBe(frames);
        expect(values.every(Number.isFinite), `${channels[ch]} q${quantum}`).toBe(true);
        expect(maxError(values, expected[ch]), `${channels[ch]} q${quantum} oracle`).toBeLessThan(ch === 6 ? 5e-6 : 3e-7);
        expect(values, `${channels[ch]} q${quantum} PCM`).toEqual(reference.outputs.main[ch]);
      });
    }
  }, 60000);
}

test('quantum-32 snapshots between 128-sample boundaries retain framing, freeze and convolution phase', async () => {
  const p = processor(), rate = 48000, quantum = 32;
  const whole = await render(p, rate, quantum);
  for (const split of [352, 928]) {
    const first = await render(p, rate, quantum, input.map(values => values.slice(0, split)));
    const continuation = await render(p, rate, quantum, input.map(values => values.slice(split)), first.state);
    expect(continuation.diagnostics.scrubbedSamples).toBe(0);
    continuation.outputs.main.forEach((values, ch) => {
      expect(values, `${channels[ch]} restore at ${split}`).toEqual(whole.outputs.main[ch].slice(split));
    });
    expect(continuation.state).toEqual(whole.state);
  }
}, 60000);

test('non-power-of-two quantum-48 restores frames whose hops do not divide the process boundary', async () => {
  const p = processor(), rate = 48000, quantum = 48, count = 2016, split = 336;
  const data = input.map(values => values.slice(0, count));
  const whole = await render(p, rate, quantum, data);
  whole.outputs.main.forEach((values, ch) => {
    expect(values.length).toBe(count);
    expect(maxError(values, expected[ch].slice(0, count)), `${channels[ch]} q48 oracle`).toBeLessThan(ch === 6 ? 5e-6 : 3e-7);
  });
  const first = await render(p, rate, quantum, data.map(values => values.slice(0, split)));
  const continuation = await render(p, rate, quantum, data.map(values => values.slice(split)), first.state);
  continuation.outputs.main.forEach((values, ch) => {
    expect(values, `${channels[ch]} q48 restore at ${split}`).toEqual(whole.outputs.main[ch].slice(split));
  });
  expect(continuation.state).toEqual(whole.state);
  expect(whole.diagnostics.scrubbedSamples + first.diagnostics.scrubbedSamples + continuation.diagnostics.scrubbedSamples).toBe(0);
}, 60000);

for (const rate of [44100, 48000, 96000]) {
  test(`resident time stretch keeps source time, launch and snapshot phase across quantums at ${rate} Hz`, async () => {
    const sourceRate = 32000;
    const pcm = Float32Array.from({ length: 1537 }, (_, n) => 0.5 * Math.sin(n * 0.09371) + 0.2 * Math.cos(n * 0.7181));
    const rows = stretchRows(frames, n => ({ durationScale: 1.37, pitchRatio: 0.83, trigger: n === 733, reset: n >= 1197 && n < 1200 }));
    const data = stretchPorts(rows), loads = [{ at: 0, data: pcm }];
    const expectedStretch = stretchReference(rows, loads, rate, sourceRate, 256, 8, 2048);
    const p = stretchProcessor(sourceRate, 2048, 256, 8);
    const run = (quantum: number, ports = data, restore?: Uint8Array) => renderOffline(p, {
      sampleRate: rate, renderQuantumSize: quantum, duration: (ports[0].length - 0.25) / rate,
      inputs: { controls: ports }, restore,
      messages: restore ? [] : [{ name: 'load', atQuantum: 0, payload: { data: pcm } }],
    });
    const reference = await run(128);
    for (const quantum of [128, 32, 256]) {
      const whole = quantum === 128 ? reference : await run(quantum);
      expect(whole.diagnostics.scrubbedSamples).toBe(0);
      whole.outputs.main.forEach((values, ch) => {
        expect(maxError(values, expectedStretch[ch]), `channel ${ch} q${quantum} oracle`).toBeLessThan(3e-7);
        expect(values, `channel ${ch} q${quantum} PCM`).toEqual(reference.outputs.main[ch]);
      });
      if (quantum === 32) {
        const split = 352;
        const first = await run(quantum, data.map(values => values.slice(0, split)));
        const continuation = await run(quantum, data.map(values => values.slice(split)), first.state);
        expect(continuation.outputs.main).toEqual(whole.outputs.main.map(values => values.slice(split)));
        expect(continuation.state).toEqual(whole.state);
        expect(continuation.diagnostics.scrubbedSamples).toBe(0);
      }
    }
  }, 60000);
}
