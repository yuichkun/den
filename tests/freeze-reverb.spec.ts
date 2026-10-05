import { test, expect } from 'vitest';
import { audioInput, audioOutput, decodeSnapshot, defineProcessor, f32, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { freezeReverb, type FreezeReverbConfig } from '../src/freeze-reverb.js';
import { energy, freezeReference, maxError, ports } from './fixtures/freeze-reverb-reference.js';
const rates = [44100, 48000, 96000];
function fixture(config: Partial<FreezeReverbConfig> = {}) {
  return defineProcessor(ctx => {
    const input = audioInput({ name: 'main', channels: 4 }), output = audioOutput({ name: 'main', channels: 4 });
    const unit = instantiate(freezeReverb, { ...config, sampleRate: ctx.sampleRate }, { name: 'freeze' });
    return { process() { forSample(i => {
      const r = unit.tick(input.ch(0).at(i), input.ch(1).at(i), { freeze: input.ch(2).at(i).gt(0), reset: input.ch(3).at(i).gt(0) });
      output.ch(0).at(i).write(r.left); output.ch(1).at(i).write(r.right);
      output.ch(2).at(i).write(r.freezeAmount); output.ch(3).at(i).write(f32(r.frozen));
    }); } };
  });
}
async function render(rate: number, data: Float32Array[], config: Partial<FreezeReverbConfig> = {}, restore?: Uint8Array) {
  const result = await renderOffline(fixture(config), { sampleRate: rate, duration: (data[0].length - .25) / rate, inputs: { main: data }, restore });
  expect(result.outputs.main[0].length).toBe(data[0].length);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  expect(result.outputs.main.every(channel => channel.every(Number.isFinite))).toBe(true);
  return result;
}
function storedEnergy(snapshot: Uint8Array) {
  const slots = decodeSnapshot(snapshot).slots.filter(s => s.kind === 'buffer');
  return slots.reduce((energy, slot) => {
    const values = new DataView(slot.data.buffer, slot.data.byteOffset, slot.data.byteLength);
    for (let offset = 0; offset < slot.data.byteLength; offset += 8) { const x = values.getFloat64(offset, true) / 2 ** 256; energy += x * x; }
    return energy;
  }, 0);
}
for (const rate of rates) {
  test(`integer unequal delays, impulse amplitude and independent native timeline ${rate}`, async () => {
    for (const config of [{ roomScale: .5, decaySeconds: .1, transitionSamples: 0 }, { roomScale: 1, decaySeconds: .6, transitionSamples: 257 }, { roomScale: 2, decaySeconds: 10, transitionSamples: 192000 }]) {
      const data = ports(32768, {
        0: n => n % 8192 === 0 ? 1 : n < 5000 ? Math.sin(n * .37) * .2 : 0,
        1: n => n === 37 ? -.5 : n < 5000 ? Math.cos(n * .13) * .3 : 0,
        2: n => Number(n >= 3101 && n < 7300 || n >= 8000 && n < 8100 || n >= 8300 && n < 8400 || n >= 9000),
        3: n => Number(n === 16383 || n >= 16400 && n < 16407),
      });
      const actual = await render(rate, data, config), expected = freezeReference(data, { ...config, sampleRate: rate });
      actual.outputs.main.forEach((channel, ch) => expect(maxError(channel, expected[ch])).toBeLessThan(3e-7));
    }
    const impulse = ports(8192, { 0: n => Number(n === 0) });
    const actual = (await render(rate, impulse)).outputs.main;
    const lengths = [297, 371, 411, 437].map(x => Math.round(x / 10000 * rate));
    expect(actual[0].slice(0, lengths[0]).every(x => x === 0)).toBe(true);
    for (let j = 0; j < 4; j++) expect(actual[0][lengths[j]]).toBe(j < 2 ? .25 : -.25);
  });

  test(`freeze and thaw ramps reverse continuously, sample endpoints and reset precedence ${rate}`, async () => {
    for (const transitionSamples of [0, 1, 7, 256, 192000]) {
      const data = ports(1024, {
        0: 1, 1: -1,
        2: n => Number(n < 17 || n >= 30 && n < 43 || n >= 127),
        3: n => Number(n === 128 || n >= 255 && n <= 260),
      });
      const actual = await render(rate, data, { transitionSamples }), expected = freezeReference(data, { sampleRate: rate, transitionSamples });
      expect(actual.outputs.main[2]).toEqual(expected[2]); expect(actual.outputs.main[3]).toEqual(expected[3]);
      for (const n of [128, 255, 256, 257, 258, 259, 260]) expect(actual.outputs.main.every(channel => channel[n] === 0)).toBe(true);
    }
  });

  test(`native frozen state energy drift, ignored excitation, thaw contraction and exact continuation ${rate}`, async () => {
    const config = { decaySeconds: .6, transitionSamples: 257 };
    const warm = ports(16384, {
      0: n => n < 8192 ? .4 * Math.sin(n * .137) + .2 * Math.cos(n * .071) : 0,
      1: n => n < 8192 ? .5 * Math.sin(n * .083) : 0,
      2: n => Number(n >= 7936),
    });
    const first = await render(rate, warm, config), initial = storedEnergy(first.state);
    expect(first.outputs.main[3].at(-1)).toBe(1); expect(initial).toBeGreaterThan(1);
    const duration = 2 ** 18;
    const hold = await render(rate, ports(duration, { 2: 1 }), config, first.state);
    const drift = Math.abs(storedEnergy(hold.state) / initial - 1);
    expect(drift).toBeLessThan(2e-10);
    expect(energy(hold.outputs.main)).toBeGreaterThan(1);
    const forced = await render(rate, ports(16384, { 0: n => n % 2 ? 1 : -1, 1: 1, 2: 1 }), config, first.state);
    expect(forced.outputs.main).toEqual(hold.outputs.main.map(channel => channel.slice(0, 16384)));
    const split = 8320, all = ports(32768, {
      0: n => n < 20000 ? .7 * Math.sin(n * .119) : 0, 1: n => .2 * Math.cos(n * .09),
      2: n => Number(n >= 8200 && n < 16000 || n >= 23000),
      3: n => Number(n === 20001 || n >= 25001 && n < 25005),
    });
    const complete = await render(rate, all, config), head = await render(rate, all.map(x => x.slice(0, split)), config);
    const continued = await render(rate, all.map(x => x.slice(split)), config, head.state);
    complete.outputs.main.forEach((channel, ch) => expect(continued.outputs.main[ch]).toEqual(channel.slice(split)));
    expect(decodeSnapshot(head.state).slots.filter(s => s.kind === 'buffer')).toHaveLength(4);
    expect(decodeSnapshot(head.state).slots.some(s => s.name.endsWith('freezeProgress'))).toBe(true);
    const switching = await render(rate, ports(32768, { 2: n => Number(n % 521 < 260) }), config, hold.state);
    expect(storedEnergy(switching.state)).toBeLessThanOrEqual(storedEnergy(hold.state) * (1 + 2e-10));
    const thaw = await render(rate, ports(2 ** 18), config, hold.state);
    expect(storedEnergy(thaw.state)).toBeLessThan(initial * 1e-12);
    const cleared = await render(rate, ports(16384, { 2: 1, 3: n => Number(n === 0 || n >= 129 && n <= 136) }), config, hold.state);
    expect(cleared.outputs.main.slice(0, 2).every(channel => channel.every(x => x === 0))).toBe(true);
    console.log(JSON.stringify({ rate, freezeFrames: duration, initialStoredEnergy: initial, relativeEnergyDrift: drift, thawStoredEnergy: storedEnergy(thaw.state), snapshotBytes: head.state.byteLength }));
  });

  test(`normalized extreme excitation, no hidden limiter, tiny f32 history and frozen silence ${rate}`, async () => {
    const config = { roomScale: .5, decaySeconds: 10, transitionSamples: 0 };
    const data = ports(32768, { 0: 1, 1: n => n % 2 ? 1 : -1, 2: n => Number(n >= 24000) });
    const actual = await render(rate, data, config), expected = freezeReference(data, { ...config, sampleRate: rate });
    actual.outputs.main.forEach((channel, ch) => expect(maxError(channel, expected[ch])).toBeLessThan(2e-6));
    expect(actual.outputs.main[0].some(x => Math.abs(x) > 1)).toBe(true);
    const empty = await render(rate, ports(16384, { 0: 1, 1: -1, 2: 1 }), config);
    expect(empty.outputs.main.slice(0, 2).every(channel => channel.every(x => x === 0))).toBe(true);
    const tiny = ports(16384, { 0: n => n === 0 ? 2 ** -140 : 0, 2: n => Number(n >= 1) });
    const result = await render(rate, tiny, config), reference = freezeReference(tiny, { ...config, sampleRate: rate });
    expect(result.outputs.main).toEqual(reference); expect(result.outputs.main[0].some(x => x !== 0)).toBe(true);
  });
}

test('construction validates finite bounds, fixed maximum delay allocation and no extra effects', () => {
  const construct = (config: FreezeReverbConfig) => defineProcessor(() => { instantiate(freezeReverb, config, { name: 'freeze' }); return { process() {} }; });
  for (const sampleRate of [NaN, Infinity, 7999, 192001, 48000.5]) expect(() => construct({ sampleRate })).toThrow(/freezeReverb/);
  for (const roomScale of [NaN, Infinity, .49, 2.01]) expect(() => construct({ sampleRate: 48000, roomScale })).toThrow(/freezeReverb/);
  for (const decaySeconds of [NaN, Infinity, .09, 10.1]) expect(() => construct({ sampleRate: 48000, decaySeconds })).toThrow(/freezeReverb/);
  for (const transitionSamples of [NaN, Infinity, -1, .5, 192001]) expect(() => construct({ sampleRate: 48000, transitionSamples })).toThrow(/freezeReverb/);
  for (const sampleRate of [8000, 192000]) for (const roomScale of [.5, 2]) expect(() => construct({ sampleRate, roomScale })).not.toThrow();
});
