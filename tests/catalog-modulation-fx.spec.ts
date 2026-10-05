import { test, expect } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate, f32, type CompiledProcessor } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { flanger, phaser, type PhaserConfig } from '../src/modulation-fx.js';
import { pingPongDelay, multiTapDelay, type DelayTap } from '../src/stereo-delay.js';
import { algorithmicReverb, type AlgorithmicReverbConfig } from '../src/reverb.js';

type Kind = 'flanger' | 'phaser' | 'pingpong' | 'multitap' | 'reverb';
type Config = Partial<AlgorithmicReverbConfig> & { stages?: PhaserConfig['stages']; capacity?: number; taps?: DelayTap[] };
const rates = [44100, 48000, 96000];
// Ports: left, right, time/frequency, feedback, mix, bypass, reset, depth, rate.
function fixture(kind: Kind, config: Config = {}) {
  return defineProcessor(ctx => {
    const input = audioInput({ channels: 9, name: 'main' }), output = audioOutput({ channels: 3, name: 'main' });
    const common = { sampleRate: ctx.sampleRate, maxDelaySeconds: (config.capacity ?? 32) / ctx.sampleRate };
    const fx = kind === 'flanger' ? instantiate(flanger, common, { name: 'fx' }) : null;
    const phase = kind === 'phaser' ? instantiate(phaser, { sampleRate: ctx.sampleRate, stages: config.stages }, { name: 'fx' }) : null;
    const ping = kind === 'pingpong' ? instantiate(pingPongDelay, common, { name: 'fx' }) : null;
    const multi = kind === 'multitap' ? instantiate(multiTapDelay, { ...common, taps: config.taps ?? [{ delaySeconds: 4 / ctx.sampleRate, gainLeft: 1, gainRight: -1 }] }, { name: 'fx' }) : null;
    const reverb = kind === 'reverb' ? instantiate(algorithmicReverb, { ...config, sampleRate: ctx.sampleRate }, { name: 'fx' }) : null;
    return { process() { forSample(i => {
      const x = (ch: number) => input.ch(ch).at(i);
      const c = { feedback: x(3), mix: x(4), bypass: x(5).gt(0), reset: x(6).gt(0) };
      let left = f32(0), right = f32(0), flag = f32(0);
      if (fx) { const r = fx.tick(x(0), x(1), { ...c, delaySeconds: x(2), depthSeconds: x(7), rateHz: x(8) }); left = r.left; right = r.right; flag = f32(r.timingRejected); }
      if (phase) left = phase.tick(x(0), { ...c, frequencyHz: x(2) });
      if (ping) { const r = ping.tick(x(0), x(1), { ...c, timeSeconds: x(2) }); left = r.left; right = r.right; flag = f32(r.timingRejected); }
      if (multi) { const r = multi.tick(x(0), c); left = r.left; right = r.right; }
      if (reverb) { const r = reverb.tick(x(0), x(1), c); left = r.left; right = r.right; }
      output.ch(0).at(i).write(left); output.ch(1).at(i).write(right); output.ch(2).at(i).write(flag);
    }); } };
  });
}
type Channel = number | ((n: number) => number);
function ports(rate: number, size: number, edits: Partial<Record<number, Channel>> = {}) {
  const defaults: Channel[] = [n => n === 0 ? 1 : 0, 0, 8 / rate, 0, 1, 0, 0, 0, 0];
  return { main: defaults.map((fallback, ch) => Float32Array.from({ length: size }, (_, n) => {
    const value = edits[ch] ?? fallback; return typeof value === 'function' ? value(n) : value;
  })) };
}
async function render(processor: CompiledProcessor, rate: number, input: ReturnType<typeof ports>, restore?: Uint8Array) {
  const r = await renderOffline(processor, { sampleRate: rate, duration: input.main[0].length / rate, inputs: input, restore });
  expect(r.diagnostics.scrubbedSamples).toBe(0);
  expect(r.outputs.main.every(a => a.every(Number.isFinite))).toBe(true);
  return r;
}
function close(a: Float32Array, b: ArrayLike<number>, tolerance = 4e-6) {
  expect(a.length).toBe(b.length);
  let error = 0;
  for (let i = 0; i < a.length; i++) error = Math.max(error, Math.abs(a[i] - b[i]));
  expect(error).toBeLessThanOrEqual(tolerance);
}
const energy = (a: ArrayLike<number>) => Array.from(a).reduce((s, x) => s + x * x, 0);
function response(a: Float32Array, omega: number) {
  let re = 0, im = 0;
  for (let n = 0; n < a.length; n++) { re += a[n] * Math.cos(omega * n); im -= a[n] * Math.sin(omega * n); }
  return { re, im };
}
const mul = (a: { re: number; im: number }, b: { re: number; im: number }) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const div = (a: { re: number; im: number }, b: { re: number; im: number }) => ({ re: (a.re * b.re + a.im * b.im) / (b.re * b.re + b.im * b.im), im: (a.im * b.re - a.re * b.im) / (b.re * b.re + b.im * b.im) });

for (const rate of rates) {
  test(`flanger has independent comb notches/peaks and bounded feedback at ${rate}`, async () => {
    const size = 4096, delay = 16;
    for (const feedback of [0, 0.75, 10]) {
      const r = await render(fixture('flanger'), rate, ports(rate, size, { 2: delay / rate, 3: feedback, 4: 0.5 }));
      const gain = Math.min(feedback, 0.95);
      for (const omega of [Math.PI / delay, 2 * Math.PI / delay, 0.15, 1.5]) {
        // Linear interpolation transfer accounts for f32 seconds independently.
        const d = Math.fround(delay / rate) * rate, whole = Math.floor(d), frac = d - whole;
        const z = { re: (1 - frac) * Math.cos(omega * whole) + frac * Math.cos(omega * (whole + 1)), im: -(1 - frac) * Math.sin(omega * whole) - frac * Math.sin(omega * (whole + 1)) };
        const wet = div(z, { re: 1 - gain * z.re, im: -gain * z.im });
        const expected = { re: 0.5 + 0.5 * wet.re, im: 0.5 * wet.im }, actual = response(r.outputs.main[0], omega);
        expect(Math.hypot(actual.re - expected.re, actual.im - expected.im)).toBeLessThan(4e-5);
      }
      if (feedback === 0) expect(Math.hypot(...Object.values(response(r.outputs.main[0], Math.PI / delay)))).toBeLessThan(2e-6);
    }
  });

  test(`normalized phaser matches independent allpass magnitude and phase at ${rate}`, async () => {
    for (const stages of [2, 4, 8] as const) {
      const frequency = 1200, r = await render(fixture('phaser', { stages }), rate, ports(rate, 8192, { 2: frequency }));
      const a = (Math.tan(Math.PI * frequency / rate) - 1) / (Math.tan(Math.PI * frequency / rate) + 1);
      for (const hz of [40, 500, frequency, 5000, rate * 0.43]) {
        const omega = 2 * Math.PI * hz / rate, z = { re: Math.cos(omega), im: -Math.sin(omega) };
        const stage = div({ re: a + z.re, im: z.im }, { re: 1 + a * z.re, im: a * z.im });
        let expected = { re: 1, im: 0 }; for (let i = 0; i < stages; i++) expected = mul(expected, stage);
        const actual = response(r.outputs.main[0], omega);
        expect(Math.hypot(actual.re - expected.re, actual.im - expected.im)).toBeLessThan(2e-6);
        expect(Math.abs(Math.hypot(actual.re, actual.im) - 1)).toBeLessThan(2e-6);
      }
      expect(Math.abs(energy(r.outputs.main[0]) - 1)).toBeLessThan(1e-6);
    }
    const mixed = await render(fixture('phaser', { stages: 2 }), rate, ports(rate, 8192, { 2: 1200, 4: 0.5 }));
    const notch = response(mixed.outputs.main[0], 2 * Math.PI * 1200 / rate);
    expect(Math.hypot(notch.re, notch.im)).toBeLessThan(2e-6);
  });

  test(`phaser rapid cutoff motion is energy bounded, including signed feedback at ${rate}`, async () => {
    for (const feedback of [0, -0.95, 0.95]) {
      const data = ports(rate, 32768, { 0: n => n < 2048 ? Math.sin(n * 1.31) * 0.4 : 0, 2: n => n % 2 ? 20 : rate, 3: feedback });
      const r = await render(fixture('phaser', { stages: 8 }), rate, data);
      // Time-varying orthogonal stages plus a delayed feedback contraction:
      // ||wet||_2 <= ||input||_2 / (1 - |g|), irrespective of cutoff trajectory.
      expect(energy(r.outputs.main[0])).toBeLessThanOrEqual(energy(data.main[0]) / (1 - Math.abs(feedback)) ** 2 * 1.000001);
      expect(energy(r.outputs.main[0].slice(-4096))).toBeLessThan(energy(r.outputs.main[0].slice(0, 4096)) * 0.1);
    }
  });

  test(`ping-pong echoes alternate at the exact read-before-write spacing at ${rate}`, async () => {
    for (const delay of [1, 8, 32]) for (const feedback of [-0.5, 0.5]) {
      const r = await render(fixture('pingpong'), rate, ports(rate, 512, { 2: delay / rate, 3: feedback }));
      for (let ch = 0; ch < 2; ch++) {
        const expected = Float32Array.from({ length: 512 }, (_, n) => n > 0 && n % delay === 0 && (n / delay - 1) % 2 === ch ? feedback ** (n / delay - 1) : 0);
        close(r.outputs.main[ch], expected);
      }
    }
  });

  test(`ping-pong variable fractional times, bounds and cross-feedback use an unbounded timeline at ${rate}`, async () => {
    const data = ports(rate, 2048, { 0: n => Math.sin(n * 0.31) * 0.1, 1: n => Math.cos(n * 0.11) * 0.1,
      2: n => (n < 256 ? 2.5 : n < 512 ? 40 : n % 3 ? 31.75 : 1) / rate, 3: n => n % 2 ? 2 : -2, 6: n => n === 128 || n === 1024 ? 1 : 0 });
    const r = await render(fixture('pingpong'), rate, data), written = [[], []] as number[][];
    const expected = [new Float32Array(2048), new Float32Array(2048)];
    let start = 0, accepted = Math.fround(1 / rate);
    for (let n = 0; n < 2048; n++) {
      const reset = data.main[6][n] > 0; if (reset) start = n;
      const t = data.main[2][n], valid = t >= Math.fround(1 / rate) && t <= Math.fround(32 / rate);
      accepted = valid ? t : reset ? Math.fround(1 / rate) : accepted;
      const d = Math.min(32, Math.max(1, accepted * rate)), position = n - d, lo = Math.floor(position), frac = position - lo;
      const wet = written.map(history => { const at = (i: number) => i >= start && i < n ? history[i] : 0; return Math.fround(at(lo) * (1 - frac) + at(lo + 1) * frac); });
      for (let ch = 0; ch < 2; ch++) {
        written[ch][n] = Math.fround((valid ? data.main[ch][n] : 0) + Math.fround(wet[1 - ch] * Math.fround(Math.max(-0.95, Math.min(0.95, data.main[3][n])))));
        expected[ch][n] = valid ? wet[ch] : data.main[ch][n];
      }
      expect(r.outputs.main[2][n]).toBe(valid ? 0 : 1);
    }
    expected.forEach((a, ch) => close(r.outputs.main[ch], a));
  });

  test(`signed multitap gains preserve stereo ratios with explicit L1 normalization at ${rate}`, async () => {
    const taps = [{ delaySeconds: 4 / rate, gainLeft: 2, gainRight: -1 }, { delaySeconds: 9 / rate, gainLeft: -1, gainRight: 1 }, { delaySeconds: 17 / rate, gainLeft: 1, gainRight: 3 }];
    const r = await render(fixture('multitap', { taps }), rate, ports(rate, 512));
    for (let ch = 0; ch < 2; ch++) {
      const expected = new Float32Array(512);
      for (const t of taps) {
        const delay = Math.fround(t.delaySeconds) * rate, lo = Math.floor(delay), frac = delay - lo, gain = (ch ? t.gainRight : t.gainLeft) / 5;
        expected[lo] += gain * (1 - frac); expected[lo + 1] += gain * frac;
      }
      close(r.outputs.main[ch], expected, 2e-7);
    }
    const dc = await render(fixture('multitap', { taps }), rate, ports(rate, 32768, { 0: 1, 3: 99 }));
    // Average normalized tap sum = .5; feedback steady state 1/(1-.95*.5).
    expect(dc.outputs.main[0].at(-1)).toBeCloseTo((2 / 5) / (1 - 0.95 * 0.5), 5);
    expect(dc.outputs.main[1].at(-1)).toBeCloseTo((3 / 5) / (1 - 0.95 * 0.5), 5);
    expect(dc.outputs.main.slice(0, 2).every(a => a.every(x => Math.abs(x) <= 20.0001))).toBe(true);
  });

  for (const kind of ['flanger', 'phaser', 'pingpong', 'multitap', 'reverb'] as const) {
    test(`${kind} reset/bypass/dry endpoints and same-schema snapshot at ${rate}`, async () => {
      const size = kind === 'reverb' ? 8192 : 1024, config = kind === 'reverb' ? { decaySeconds: 0.2, dampingHz: 2000 } : {};
      const p = fixture(kind, config), settings = { 2: kind === 'phaser' ? 1000 : 8 / rate, 3: 0.7 };
      const whole = await render(p, rate, ports(rate, size * 2, settings));
      const first = await render(p, rate, ports(rate, size, settings));
      const resumed = await render(p, rate, ports(rate, size, { ...settings, 0: 0 }), first.state);
      for (let ch = 0; ch < 2; ch++) close(resumed.outputs.main[ch], whole.outputs.main[ch].slice(size), 0);
      const fresh = await render(p, rate, ports(rate, size, { ...settings, 0: 0 }));
      expect(fresh.outputs.main.slice(0, 2).every(a => a.every(x => x === 0))).toBe(true);
      const cleared = await render(p, rate, ports(rate, size, { ...settings, 0: 0, 6: n => n === 0 ? 1 : 0 }), first.state);
      expect(cleared.outputs.main.slice(0, 2).every(a => a.every(x => x === 0))).toBe(true);
      const dry = await render(p, rate, ports(rate, 128, { ...settings, 0: 0.25, 1: -0.125, 4: 0 }));
      expect(dry.outputs.main[0].every(x => x === 0.25)).toBe(true);
      if (kind !== 'phaser') expect(dry.outputs.main[1].every(x => x === (kind === 'multitap' ? 0.25 : -0.125))).toBe(true);
      const bypassed = await render(p, rate, ports(rate, size, { ...settings, 0: 0.25, 1: -0.125, 5: 1 }), first.state);
      expect(bypassed.outputs.main[0].every(x => x === 0.25)).toBe(true);
      const afterBypass = await render(p, rate, ports(rate, size, { ...settings, 0: 0 }), bypassed.state);
      const silentTail = await render(p, rate, ports(rate, size * 2, { ...settings, 0: 0 }), first.state);
      for (let ch = 0; ch < 2; ch++) close(afterBypass.outputs.main[ch], silentTail.outputs.main[ch].slice(size), 0);
    });
  }
}

test('construction rejects unsafe rates, capacities, stage counts, tap lists and reverb coefficients', () => {
  const checks = [
    () => instantiate(phaser, { sampleRate: 1 }), () => instantiate(phaser, { sampleRate: 48000, stages: 3 as never }),
    () => instantiate(flanger, { sampleRate: 48000, maxDelaySeconds: 0.021 }),
    () => instantiate(pingPongDelay, { sampleRate: 48000, maxDelaySeconds: 9 }),
    () => instantiate(multiTapDelay, { sampleRate: 48000, taps: [] }),
    () => instantiate(multiTapDelay, { sampleRate: 48000, taps: [{ delaySeconds: -1, gainLeft: 1, gainRight: 1 }] }),
    ...[NaN, Infinity, 0, -1, 11].map(decaySeconds => () => instantiate(algorithmicReverb, { sampleRate: 48000, decaySeconds })),
    () => instantiate(algorithmicReverb, { sampleRate: 48000, roomScale: 3 }),
    () => instantiate(algorithmicReverb, { sampleRate: 48000, dampingHz: 24000 }),
  ];
  for (const check of checks) expect(() => defineProcessor(() => { check(); return { process() {} }; })).toThrow(RangeError);
});

for (const rate of rates) {
  test(`phaser DC/Nyquist and bounded frequency endpoints remain allpass at ${rate}`, async () => {
    for (const requested of [-100, 20, rate]) {
      const frequency = Math.max(20, Math.min(0.45 * rate, requested));
      const r = await render(fixture('phaser', { stages: 8 }), rate, ports(rate, 65536, { 2: requested }));
      for (const omega of [0, 2 * Math.PI * frequency / rate, Math.PI]) {
        const h = response(r.outputs.main[0], omega);
        expect(Math.abs(Math.hypot(h.re, h.im) - 1)).toBeLessThan(3e-6);
      }
      expect(Math.abs(energy(r.outputs.main[0]) - 1)).toBeLessThan(1e-6);
    }
  });
  test(`flanger LFO phase yields stereo motion and preserved mono fold-down at ${rate}`, async () => {
    const input = ports(rate, 16384, { 0: n => Math.sin(2 * Math.PI * 440 * n / rate) * 0.25,
      1: n => Math.sin(2 * Math.PI * 440 * n / rate) * 0.25, 2: 16 / rate, 3: 0.8, 4: 0.5, 7: 12 / rate, 8: 7 });
    const r = await render(fixture('flanger'), rate, input);
    const difference = Float32Array.from(r.outputs.main[0], (x, n) => x - r.outputs.main[1][n]);
    const mono = Float32Array.from(r.outputs.main[0], (x, n) => (x + r.outputs.main[1][n]) / 2);
    expect(energy(difference)).toBeGreaterThan(1);
    expect(energy(mono)).toBeGreaterThan(energy(input.main[0]) * 0.01);
    expect(r.outputs.main.slice(0, 2).every(a => a.every(x => Math.abs(x) <= 5))).toBe(true);
  });
}
