import { test, expect } from 'vitest';
import { audioInput, audioOutput, bool, defineProcessor, f32, f64, forSample, instantiate, select } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { dualHeadDelay, type DualHeadDelayConfig } from '../src/dual-head-delay.js';
import { channels, dualHeadDelayReference, maxError } from './fixtures/dual-head-delay-reference.js';
const rates = [44100, 48000, 96000];
function fixture(capacity = 64, transition = 17) {
  return defineProcessor(ctx => {
    const input = audioInput({ name: 'main', channels: 6 }), output = audioOutput({ name: 'main', channels: 5 });
    const config = { sampleRate: ctx.sampleRate, maxDelaySeconds: capacity / ctx.sampleRate, transitionSamples: transition };
    const a = instantiate(dualHeadDelay, config, { name: 'read' });
    const b = instantiate(dualHeadDelay, config, { name: 'tick' });
    return { process() { forSample(i => {
      const x = input.ch(0).at(i), time = input.ch(1).at(i), reset = input.ch(2).at(i).gt(0);
      const tap = a.read(time, reset);
      tap.write(f32(f64(x).add(f64(tap.output).mul(f64(input.ch(3).at(i))))));
      const mix = f64(input.ch(4).at(i)).clamp(0, 1);
      output.ch(0).at(i).write(tap.output);
      output.ch(1).at(i).write(f32(tap.timingRejected));
      output.ch(2).at(i).write(f32(tap.transitioning));
      output.ch(3).at(i).write(f32(f64(x).mul(f64(1).sub(mix)).add(f64(tap.output).mul(mix))));
      output.ch(4).at(i).write(b.tick(input.ch(5).at(i), time, bool(false)).output);
    }); } };
  });
}
const render = (rate: number, ports: Float32Array[], capacity = 64, transition = 17, restore?: Uint8Array) => renderOffline(fixture(capacity, transition), {
  sampleRate: rate, duration: (ports[0].length - .25) / rate, inputs: { main: ports }, restore,
});
for (const rate of rates) {
  test(`fixed-head fractional impulse, extrema and wrap at ${rate}`, async () => {
    for (const delay of [1, 1.5, 3.25, 31.75, 64]) {
      const ports = channels(512, rate, { 0: n => n === 0 ? 1 : n === 175 ? -.5 : 0, 1: delay / rate });
      const result = await render(rate, ports);
      const expected = dualHeadDelayReference(ports, { rate, capacity: 64, transition: 17 });
      expect(maxError(result.outputs.main[0], expected[0])).toBeLessThan(2e-7);
      expect(result.outputs.main[2].every(x => x === 0)).toBe(true);
      expect(result.outputs.main[4].every(x => x === 0)).toBe(true);
      expect(result.diagnostics.scrubbedSamples).toBe(0);
    }
  });
  test(`latest request coalesces without moving or restarting active heads at ${rate}`, async () => {
    const ports = channels(1024, rate, {
      0: n => .5 * Math.sin(n * .29) + .25 * Math.cos(n * .13),
      1: n => (n < 128 ? 3.25 : n < 133 ? 40.5 : n < 135 ? 2 : n < 144 ? 63.75 : n < 200 ? 6.25 : n < 256 ? 16 : 1 + (n * 11) % 63) / rate,
      4: n => (n % 91) / 90, 5: .125,
    });
    const result = await render(rate, ports), expected = dualHeadDelayReference(ports, { rate, capacity: 64, transition: 17 });
    for (let ch = 0; ch < 4; ch++) expect(maxError(result.outputs.main[ch], expected[ch])).toBeLessThan(3e-7);
    expect(Array.from(result.outputs.main[2].slice(128, 161))).toEqual(new Array(33).fill(1));
    expect(result.outputs.main[4].slice(100).every(x => x === .125)).toBe(true);
    // The legacy moving trajectory must fail this independent transition oracle.
    const moving = Float32Array.from(ports[0], (_, n) => {
      const t = n - ports[1][n] * rate, k = Math.floor(t), a = t - k;
      return (ports[0][k] ?? 0) * (1 - a) + (ports[0][k + 1] ?? 0) * a;
    });
    expect(maxError(moving, expected[0])).toBeGreaterThan(.3);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  });
  test(`two fixed sinusoidal heads preserve carrier and expose midpoint cancellation at ${rate}`, async () => {
    const ports = channels(2048, rate, { 0: n => Math.sin(2 * Math.PI * n / 32), 1: n => (n < 512 ? 8 : 24) / rate });
    const result = await render(rate, ports, 64, 33), actual = result.outputs.main[0];
    const expected = dualHeadDelayReference(ports, { rate, capacity: 64, transition: 33 })[0];
    expect(maxError(actual, expected)).toBeLessThan(3e-7);
    expect(Math.abs(actual[528])).toBeLessThan(3e-6);
    const bin = (start: number, count: number, frequency: number) => {
      let re = 0, im = 0;
      for (let n = 0; n < count; n++) { re += actual[start + n] * Math.cos(2 * Math.PI * frequency * n); im -= actual[start + n] * Math.sin(2 * Math.PI * frequency * n); }
      return 2 * Math.hypot(re, im) / count;
    };
    for (const start of [128, 1024]) {
      expect(bin(start, 256, 1 / 32)).toBeCloseTo(1, 5);
      expect(bin(start, 256, 1 / 16)).toBeLessThan(2e-6);
    }
    // A linear ramping head would move a sinusoid's read frequency; the two fixed
    // heads instead follow the explicitly weighted same-frequency analytic sum.
    for (let j = 0; j < 33; j++) {
      const n = 512 + j, a = j / 32;
      const formula = (1 - a) * Math.sin(2 * Math.PI * (n - ports[1][0] * rate) / 32)
        + a * Math.sin(2 * Math.PI * (n - ports[1][512] * rate) / 32);
      expect(Math.abs(actual[n] - formula)).toBeLessThan(3e-6);
    }
  });
  test(`feedback/mix, finite tail, held reset and in-flight snapshot at ${rate}`, async () => {
    const ports = channels(512, rate, {
      0: n => n < 190 ? .125 * Math.cos(n * .2) : 0,
      1: n => (n < 120 ? 3.5 : n < 125 ? 27.25 : n < 143 ? 8.75 : 1.5) / rate,
      2: n => n === 257 || (n >= 389 && n < 394) ? 1 : 0, 3: .5,
      4: n => n % 79 / 78,
    });
    const whole = await render(rate, ports), expected = dualHeadDelayReference(ports, { rate, capacity: 64, transition: 17 });
    for (let ch = 0; ch < 4; ch++) expect(maxError(whole.outputs.main[ch], expected[ch])).toBeLessThan(3e-7);
    const first = await render(rate, ports.map(x => x.slice(0, 128)));
    const rest = await render(rate, ports.map(x => x.slice(128)), 64, 17, first.state);
    whole.outputs.main.forEach((ch, i) => expect(Array.from(rest.outputs.main[i])).toEqual(Array.from(ch.slice(128))));
    for (const n of [257, 389, 390, 391, 392, 393]) expect(whole.outputs.main[0][n]).toBe(0);
    const plain = channels(512, rate, { 0: n => n === 10 ? 1 : 0, 1: n => (1 + n % 64) / rate });
    const tail = await render(rate, plain);
    expect(tail.outputs.main[0].slice(75).every(x => x === 0)).toBe(true);
    const min = channels(128, rate, { 0: n => n === 0 ? 1 : 0, 1: 1 / rate, 3: .5 });
    const minimum = await render(rate, min, 1, 2);
    for (let n = 1; n < 24; n++) expect(minimum.outputs.main[0][n]).toBe(Math.fround(.5 ** (n - 1)));
  });
}

test('invalid graph-native timing rejects and retains queued valid target including reset', async () => {
  const processor = defineProcessor(ctx => {
    const output = audioOutput({ name: 'main', channels: 3 });
    const unit = instantiate(dualHeadDelay, { sampleRate: ctx.sampleRate, maxDelaySeconds: 64 / ctx.sampleRate, transitionSamples: 17 }, { name: 'delay' });
    return { process() { forSample(i => {
      const time = select(i.lt(16), f32(NaN), select(i.eq(16), f32(16 / ctx.sampleRate), select(i.eq(18), f32(32 / ctx.sampleRate),
        select(i.lt(32), f32(Infinity), select(i.lt(64), f32(-Infinity), select(i.lt(96), f32(-1), f32(1)))))));
      const tap = unit.tick(f32(.25), time, i.eq(80));
      output.ch(0).at(i).write(tap.output); output.ch(1).at(i).write(f32(tap.timingRejected)); output.ch(2).at(i).write(f32(tap.transitioning));
    }); } };
  });
  const rate = 48000, result = await renderOffline(processor, { sampleRate: rate, duration: 128 / rate });
  const ports = channels(128, rate, { 0: .25, 1: n => n < 16 ? NaN : n === 16 ? 16 / rate : n === 18 ? 32 / rate : n < 32 ? Infinity : n < 64 ? -Infinity : n < 96 ? -1 : 1, 2: n => n === 80 ? 1 : 0 });
  const expected = dualHeadDelayReference(ports, { rate, capacity: 64, transition: 17 });
  for (let ch = 0; ch < 3; ch++) expect(maxError(result.outputs.main[ch], expected[ch])).toBeLessThan(2e-7);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
});

test('convex fixed-head and mix operations preserve full-range and tiny finite f32 audio without scrubbing', async () => {
  for (const rate of rates) for (const value of [Math.fround(1e-40), -Math.fround(1e-40), 2 ** -149, -(2 ** -149), Math.fround(3.4028234663852886e38), -Math.fround(3.4028234663852886e38)]) {
    const ports = channels(512, rate, { 0: value, 1: n => (n < 128 ? 2 : 3 + n % 50) / rate, 4: .5 });
    const result = await render(rate, ports);
    expect(result.outputs.main[0].slice(64).every(x => x === value)).toBe(true);
    expect(result.outputs.main[3].slice(64).every(x => x === value)).toBe(true);
    expect(result.outputs.main[0].every(Number.isFinite)).toBe(true);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
  for (const rate of rates) {
  const max = Math.fround(3.4028234663852886e38);
  const ports = channels(1024, rate, { 0: n => n % 2 ? max : -max, 1: n => (n % 3 ? 2.5 : 61.75) / rate, 4: n => n % 89 / 88 });
  const result = await render(rate, ports), expected = dualHeadDelayReference(ports, { rate, capacity: 64, transition: 17 });
  for (const ch of [0, 3]) {
    expect(result.outputs.main[ch].every(x => Number.isFinite(x) && Math.abs(x) <= max)).toBe(true);
    let relative = 0; result.outputs.main[ch].forEach((x, i) => relative = Math.max(relative, Math.abs(x / max - expected[ch][i] / max)));
    expect(relative).toBeLessThan(2e-7);
  }
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
});

test('configuration validates rate, fixed capacity and fade length; endpoints remain constructible', () => {
  const construct = (config: DualHeadDelayConfig) => defineProcessor(() => {
    instantiate(dualHeadDelay, config, { name: 'validation' }); return { process() {} };
  });
  for (const config of [
    { sampleRate: 0 }, { sampleRate: NaN }, { sampleRate: 48000.1 }, { sampleRate: 192001 },
    { sampleRate: 48000, maxDelaySeconds: 0 }, { sampleRate: 48000, maxDelaySeconds: 1 / 96000 },
    { sampleRate: 48000, maxDelaySeconds: 8.1 }, { sampleRate: 48000, maxDelaySeconds: Infinity },
    { sampleRate: 48000, transitionSamples: 1 }, { sampleRate: 48000, transitionSamples: 2.5 },
    { sampleRate: 48000, transitionSamples: 65537 }, { sampleRate: 48000, transitionSamples: NaN },
  ]) expect(() => construct(config)).toThrow(/dualHeadDelay/);
  for (const rate of [8000, 44100, 48000, 96000, 192000]) for (const capacity of [1 / rate, 8]) for (const transitionSamples of [2, 65536]) {
    expect(() => construct({ sampleRate: rate, maxDelaySeconds: capacity, transitionSamples })).not.toThrow();
  }
});

test('two-sample fade endpoints and queue cancellation/return-to-current are explicit', async () => {
  const rate = 48000;
  for (const transition of [2, 5]) for (const policy of ['cancel', 'return', 'keep-invalid']) {
    const ports = channels(128, rate, {
      0: n => Math.sin(n * .3),
      1: n => n < 16 ? 2 / rate : n === 16 ? 8 / rate : n === 17 ? (policy === 'return' ? 2 : 12) / rate : policy === 'cancel' ? 8 / rate : policy === 'return' ? 2 / rate : -1,
    });
    const result = await render(rate, ports, 64, transition), expected = dualHeadDelayReference(ports, { rate, capacity: 64, transition });
    for (let ch = 0; ch < 4; ch++) expect(maxError(result.outputs.main[ch], expected[ch])).toBeLessThan(3e-7);
    expect(result.outputs.main[2][15]).toBe(0);
    expect(Array.from(result.outputs.main[2].slice(16, 16 + transition))).toEqual(new Array(transition).fill(1));
    if (policy === 'cancel') expect(result.outputs.main[2][16 + transition]).toBe(0);
    else {
      expect(result.outputs.main[2][16 + transition]).toBe(1);
      expect(result.outputs.main[2][16 + 2 * transition]).toBe(0);
    }
  }
});

test('only representable nominal endpoints are accepted, without broad epsilon', async () => {
  const neighbor = (value: number, direction: number) => {
    const bits = new Uint32Array(1), number = new Float32Array(bits.buffer); number[0] = value; bits[0] += direction; return number[0];
  };
  for (const rate of rates) {
    const low = Math.fround(1 / rate), high = Math.fround(31.75 / rate);
    const values = [low, neighbor(low, -1), neighbor(low, 1), high, neighbor(high, 1), neighbor(high, -1)];
    const ports = channels(128, rate, { 0: n => n / 128, 1: n => values[n % values.length] });
    const result = await render(rate, ports, 31.75, 2), expected = dualHeadDelayReference(ports, { rate, capacity: 31.75, transition: 2 });
    expect(Array.from(result.outputs.main[1])).toEqual(Array.from({ length: 128 }, (_, n) => [0, 1, 0, 0, 1, 0][n % 6]));
    expect(maxError(result.outputs.main[0], expected[0])).toBeLessThan(2e-7);
  }
});

test('maximum 65536-sample fade completes exactly and retains its two offsets', async () => {
  const rate = 48000, transition = 65536, n = 65792;
  const ports = channels(n, rate, { 0: i => Math.sin(i * .1), 1: i => (i < 64 ? 2 : i < 100 ? 32 : 48) / rate });
  const result = await render(rate, ports, 64, transition), expected = dualHeadDelayReference(ports, { rate, capacity: 64, transition });
  expect(maxError(result.outputs.main[0], expected[0])).toBeLessThan(3e-7);
  expect(result.outputs.main[2][63]).toBe(0);
  expect(result.outputs.main[2][64]).toBe(1);
  expect(result.outputs.main[2][65599]).toBe(1);
  expect(result.outputs.main[2][65600]).toBe(1);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
});

test('actual eight-second maximum impulse delay at all three offline rates', async () => {
  for (const sampleRate of rates) {
    const processor = defineProcessor(ctx => {
      const input = audioInput({ name: 'main', channels: 1 }), output = audioOutput({ name: 'main', channels: 1 });
      const unit = instantiate(dualHeadDelay, { sampleRate: ctx.sampleRate, maxDelaySeconds: 8, transitionSamples: 2 }, { name: 'maximum' });
      return { process() { forSample(i => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), f32(8), bool(false)).output)); } };
    });
    const lag = 8 * sampleRate, frames = Math.ceil((lag + 128) / 128) * 128, input = new Float32Array(frames);
    input[0] = 1; input[100] = -.5;
    const result = await renderOffline(processor, { sampleRate, duration: (frames - .25) / sampleRate, inputs: { main: [input] } });
    expect(result.outputs.main[0].length).toBe(frames);
    expect(result.outputs.main[0][lag]).toBe(1); expect(result.outputs.main[0][lag + 100]).toBe(-.5);
    expect(result.outputs.main[0].filter(x => x !== 0)).toEqual(new Float32Array([1, -.5]));
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  }
}, 30000);
