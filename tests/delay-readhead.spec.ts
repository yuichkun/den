import { test, expect } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate, f32, select, type CompiledProcessor } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { expectAudioMatches, expectNoNaN } from '@unworklet/test';
import { delayReadhead } from '../src/delay-readhead.js';

const rates = [44100, 48000, 96000];
const length = 256;
function fixture(capacitySamples: number) {
  return defineProcessor(ctx => {
    const input = audioInput({ channels: 4, name: 'main' });
    const output = audioOutput({ channels: 3, name: 'main' });
    const a = instantiate(delayReadhead, { sampleRate: ctx.sampleRate, maxDelaySeconds: capacitySamples / ctx.sampleRate }, { name: 'a' });
    const b = instantiate(delayReadhead, { sampleRate: ctx.sampleRate, maxDelaySeconds: capacitySamples / ctx.sampleRate }, { name: 'b' });
    return { process() { forSample(i => {
      const result = a.tick(input.ch(0).at(i), input.ch(1).at(i), input.ch(2).at(i).gt(0));
      const isolated = b.tick(input.ch(3).at(i), input.ch(1).at(i), f32(0).gt(1));
      output.ch(0).at(i).write(result.output);
      output.ch(1).at(i).write(f32(result.outOfRange));
      output.ch(2).at(i).write(isolated.output);
    }); } };
  });
}
// Independent unbounded timeline oracle: no ring, pointers, or copied DSP recurrence.
function reference(input: Float32Array, times: Float32Array, resets: Float32Array, rate: number, maximum: number) {
  let start = 0;
  return Float32Array.from(input, (_, n) => {
    if (resets[n] > 0) start = n;
    const samples = times[n] * rate;
    const delay = Number.isNaN(samples) ? 1 : Math.max(1, Math.min(maximum, samples));
    const position = n - delay;
    const before = Math.floor(position), alpha = position - before;
    const at = (index: number) => index >= start && index < n ? input[index] : 0;
    return at(before) * (1 - alpha) + at(before + 1) * alpha;
  });
}
async function render(processor: CompiledProcessor, rate: number, input: Float32Array, times: Float32Array, resets = new Float32Array(length), other = new Float32Array(length), restore?: Uint8Array) {
  return renderOffline(processor, { sampleRate: rate, duration: length / rate, inputs: { main: [input, times, resets, other] }, restore });
}
for (const rate of rates) {
  test(`impulse alignment, fractional taps, shortest/max time and repeated wrap at ${rate}`, async () => {
    const input = new Float32Array(length); input[0] = 1; input[34] = -0.5; input[200] = 0.25;
    for (const delay of [0, 1, 1.25, 2.5, 15, 15.75, 16, 99]) {
      const times = new Float32Array(length).fill(delay / rate);
      const result = await render(fixture(16), rate, input, times);
      expectNoNaN(result);
      expect(result.diagnostics.scrubbedSamples).toBe(0);
      expect(result.outputs.main[0]).toHaveLength(length);
      const expected = reference(input, times, new Float32Array(length), rate, 16);
      expectAudioMatches({ ...result, outputs: { main: [result.outputs.main[0]] } }, [expected], { tolerance: 2e-6 });
      expect(result.outputs.main[2].every(x => x === 0)).toBe(true);
      const flag = times[0] < Math.fround(1 / rate) || times[0] > Math.fround(16 / rate) ? 1 : 0;
      expect(result.outputs.main[1].every(x => x === flag)).toBe(true);
    }
  });
  test(`abrupt jumps and continuous moving-head modulation follow the input timeline at ${rate}`, async () => {
    const input = Float32Array.from({ length }, (_, n) => Math.sin(n * 0.37) * 0.6 + Math.cos(n * 0.11) * 0.3);
    for (const trajectory of [(n: number) => n < 80 ? 3.25 : n < 160 ? 27.5 : 1, (n: number) => 16 + 12 * Math.sin(n * 0.08)]) {
      const times = Float32Array.from({ length }, (_, n) => trajectory(n) / rate);
      const result = await render(fixture(32), rate, input, times);
      const expected = reference(input, times, new Float32Array(length), rate, 32);
      expectAudioMatches({ ...result, outputs: { main: [result.outputs.main[0]] } }, [expected], { tolerance: 2e-6 });
      // A one-sample alignment error must not pass this fixture.
      expect(() => expectAudioMatches({ ...result, outputs: { main: [result.outputs.main[0]] } }, [expected.slice().reverse()], { tolerance: 2e-6 })).toThrow();
    }
  });
  test(`reset at wrap/block boundaries masks both fractional taps; independent instances survive at ${rate}`, async () => {
    const input = Float32Array.from({ length }, (_, n) => (n % 31) / 32);
    const times = Float32Array.from({ length }, (_, n) => (n % 3 === 0 ? 16 : 1.5) / rate);
    const resets = new Float32Array(length);
    for (const n of [17, 18, 127, 128, 129, 237]) resets[n] = 1;
    const other = new Float32Array(length).fill(0.75);
    const result = await render(fixture(16), rate, input, times, resets, other);
    for (const [channel, expected] of [[0, reference(input, times, resets, rate, 16)], [2, reference(other, times, new Float32Array(length), rate, 16)]] as const) {
      expectAudioMatches({ ...result, outputs: { main: [result.outputs.main[channel]] } }, [expected], { tolerance: 2e-6 });
    }
    for (const n of [17, 18, 127, 128, 129, 237]) expect(result.outputs.main[0][n]).toBe(0);
  });
  test(`same-schema snapshot continues history and reset cannot resurrect old samples at ${rate}`, async () => {
    const processor = fixture(32);
    const times = new Float32Array(length).fill(10.5 / rate);
    const initial = Float32Array.from({ length }, (_, n) => n / length);
    const first = await render(processor, rate, initial, times);
    const zero = new Float32Array(length);
    const continued = await render(processor, rate, zero, times, zero, zero, first.state);
    const all = new Float32Array(length * 2); all.set(initial);
    const expected = reference(all, new Float32Array(length * 2).fill(times[0]), new Float32Array(length * 2), rate, 32).slice(length);
    expectAudioMatches({ ...continued, outputs: { main: [continued.outputs.main[0]] } }, [expected], { tolerance: 2e-6 });
    const resets = zero.slice(); resets[0] = 1;
    const reset = await render(processor, rate, zero, times, resets, zero, first.state);
    expect(reset.outputs.main[0].every(x => x === 0)).toBe(true);
    const fresh = await render(processor, rate, zero, times);
    expect(fresh.outputs.main[0].every(x => x === 0)).toBe(true);
  });
}

for (const rate of rates) {
  test(`linear time ramp changes pitch by 1 - delay slope at ${rate}`, async () => {
    // Integer moving positions avoid interpolation error: increasing delay by one
    // sample/sample freezes the read position, decreasing by one doubles frequency.
    const input = Float32Array.from({ length }, (_, n) => Math.sin(2 * Math.PI * n / 32));
    for (const slope of [-1, 1]) {
      const times = Float32Array.from({ length }, (_, n) => (slope === 1 ? n + 1 : 255 - n) / rate);
      const result = await render(fixture(256), rate, input, times);
      for (let n = 128; n < 254; n++) {
        const expected = slope === 1 ? 0 : Math.sin(2 * Math.PI * (2 * n - 255) / 32);
        expect(Math.abs(result.outputs.main[0][n] - expected)).toBeLessThan(4e-6);
      }
    }
  });
}

test('non-finite and out-of-range time controls saturate safely and report invalid requests', async () => {
  const processor = defineProcessor(ctx => {
    const output = audioOutput({ channels: 2, name: 'main' });
    const cell = instantiate(delayReadhead, { sampleRate: ctx.sampleRate, maxDelaySeconds: 16 / ctx.sampleRate }, { name: 'cell' });
    return { process() { forSample(i => {
      // Graph constants bypass any host input scrubbing.
      const time = select(i.lt(32), f32(NaN), select(i.lt(64), f32(Infinity), select(i.lt(96), f32(-Infinity), f32(-1))));
      const result = cell.tick(f32(0.5), time, i.eq(-1));
      output.ch(0).at(i).write(result.output);
      output.ch(1).at(i).write(f32(result.outOfRange));
    }); } };
  });
  const result = await renderOffline(processor, { sampleRate: 48000, duration: 128 / 48000 });
  expectNoNaN(result);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  expect(result.outputs.main[0][0]).toBe(0);
  expect(result.outputs.main[0].slice(1).every(x => x === 0.5)).toBe(true);
  expect(result.outputs.main[1].every(x => x === 1)).toBe(true);
});

test('capacity validation rejects invalid allocation before rendering', async () => {
  for (const config of [
    { sampleRate: 0 }, { sampleRate: NaN }, { sampleRate: Infinity },
    { sampleRate: 48000, maxDelaySeconds: 0 }, { sampleRate: 48000, maxDelaySeconds: -1 },
    { sampleRate: 48000, maxDelaySeconds: NaN }, { sampleRate: 48000, maxDelaySeconds: Infinity },
    { sampleRate: 48000, maxDelaySeconds: 0.5 / 48000 },
    { sampleRate: 48000, maxDelaySeconds: 0x7fffffff / 48000 },
  ]) {
    expect(() => defineProcessor(() => {
      instantiate(delayReadhead, config, { name: 'invalid' });
      return { process() {} };
    })).toThrow(/delayReadhead requires/);
  }
});

test('two-second default is overridable by an eight-second construction capacity', async () => {
  for (const rate of rates) for (const maximum of [undefined, 8]) {
    const processor = defineProcessor(ctx => {
      const output = audioOutput({ channels: 1, name: 'main' });
      const cell = instantiate(delayReadhead, { sampleRate: ctx.sampleRate, maxDelaySeconds: maximum }, { name: 'cell' });
      return { process() { forSample(i => {
        const result = cell.tick(f32(1), f32(4), i.eq(-1));
        output.ch(0).at(i).write(f32(result.outOfRange));
      }); } };
    });
    const result = await renderOffline(processor, { sampleRate: rate, duration: 128 / rate });
    expect(result.outputs.main[0].every(x => x === (maximum === undefined ? 1 : 0))).toBe(true);
  }
});

test('non-integral and one-sample capacities wrap without leaking overwritten input', async () => {
  for (const capacity of [1, 1.5, 15.75]) {
    const rate = 48000;
    const input = Float32Array.from({ length }, (_, n) => ((n * 19) % 47 - 23) / 32);
    const times = new Float32Array(length).fill(capacity / rate);
    const result = await render(fixture(capacity), rate, input, times);
    const expected = reference(input, times, new Float32Array(length), rate, capacity);
    expectAudioMatches({ ...result, outputs: { main: [result.outputs.main[0]] } }, [expected], { tolerance: 2e-6 });
  }
});

test('an abrupt eight-sample time increase skips backward immediately without a crossfade', async () => {
  const rate = 48000;
  const input = Float32Array.from({ length }, (_, n) => n / 256);
  const times = Float32Array.from({ length }, (_, n) => (n < 128 ? 3 : 11) / rate);
  const result = await render(fixture(16), rate, input, times);
  expect(Math.abs(result.outputs.main[0][128] - result.outputs.main[0][127] + 7 / 256)).toBeLessThan(2e-6);
});

for (const rate of rates) {
  test(`read-before-write composes feedback without an extra sample at ${rate}`, async () => {
    const processor = defineProcessor(ctx => {
      const input = audioInput({ channels: 2, name: 'main' });
      const output = audioOutput({ channels: 2, name: 'main' });
      const feedback = instantiate(delayReadhead, { sampleRate: ctx.sampleRate, maxDelaySeconds: 1 / ctx.sampleRate }, { name: 'feedback' });
      const isolated = instantiate(delayReadhead, { sampleRate: ctx.sampleRate, maxDelaySeconds: 1 / ctx.sampleRate }, { name: 'isolated' });
      return { process() { forSample(i => {
        const tap = feedback.read(f32(1 / ctx.sampleRate), input.ch(1).at(i).gt(0));
        // Only a composition fixture: no feedback engine or new feedback policy.
        tap.write(input.ch(0).at(i).add(tap.output.mul(0.5)));
        output.ch(0).at(i).write(tap.output);
        const other = isolated.read(f32(1 / ctx.sampleRate), f32(0).gt(1));
        other.write(f32(0));
        output.ch(1).at(i).write(other.output);
      }); } };
    });
    const impulse = new Float32Array(length);
    const resets = new Float32Array(length);
    for (const n of [0, 64, 128, 192]) { impulse[n] = 1; resets[n] = 1; }
    const result = await renderOffline(processor, { sampleRate: rate, duration: length / rate, inputs: { main: [impulse, resets] } });
    // Closed form, not a feedback recurrence. Reset every 64 frames keeps
    // the tail above unworklet's 1e-30 state-flush threshold.
    const expected = Float32Array.from({ length }, (_, n) => n % 64 === 0 ? 0 : 2 ** (1 - n % 64));
    expect(result.outputs.main[0].slice(0, 6)).toEqual(new Float32Array([0, 1, 0.5, 0.25, 0.125, 0.0625]));
    expectAudioMatches({ ...result, outputs: { main: [result.outputs.main[0]] } }, [expected], { tolerance: 0 });
    expect(result.outputs.main[1].every(x => x === 0)).toBe(true);
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  });
}
