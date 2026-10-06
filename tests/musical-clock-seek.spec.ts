import { expect, test as baseTest } from 'vitest';
import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, inspect } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { musicalClock, type MusicalClockConfig } from '../src/modulation.js';
const test = (name: string, fn: () => unknown) => baseTest(name, fn, 30000);
const MIN = 2 ** -149, MAX_PHASE = 1 - 2 ** -24;
function adjacent32(x: number, direction: number) {
  if (x === 0) return direction * MIN;
  const data = new Float32Array([x]), bits = new Uint32Array(data.buffer);
  bits[0] += Math.sign(x) === direction ? 1 : -1;
  return data[0];
}
// Integer multiples of the least positive f32: no floating modulo/cancellation.
function units32(x: number) {
  const data = new Float32Array([x]), bits = new Uint32Array(data.buffer)[0];
  const exponent = bits >>> 23 & 255, mantissa = bits & 0x7fffff;
  const magnitude = exponent === 0 ? BigInt(mantissa) : BigInt(mantissa + 0x800000) << BigInt(exponent - 1);
  return bits >>> 31 ? -magnitude : magnitude;
}
function previous64(x: number) {
  const data = new Float64Array([x]), bits = new BigUint64Array(data.buffer);
  bits[0] -= 1n;
  return data[0];
}
function expectedPosition(x: number, steps: number) {
  const scale = 1n << 149n, cycle = BigInt(steps) * scale;
  const bounded = Math.max(-1048576, Math.min(1048576, Math.fround(x)));
  const remainder = ((units32(bounded) % cycle) + cycle) % cycle;
  const value = Math.min(previous64(steps), Number(remainder) / Number(scale));
  const step = Math.floor(value), phase = Math.min(MAX_PHASE, Math.fround(value - step));
  return { step, phase };
}
const positions = [-(2 ** -149), -(2 ** -126), -(2 ** -60), -(2 ** -24), 0, MIN, 2 ** -60];
for (let x = -65; x <= 65; x++) positions.push(adjacent32(x, -1), x, adjacent32(x, 1));
for (const x of [-1048576, 1048576]) positions.push(adjacent32(x, -1), x, adjacent32(x, 1));
positions.push(-1e30, 1e30, -(2 ** -60));
const size = Math.ceil((positions.length * 2 + 1) / 128) * 128;
const controls = [Float32Array.from({ length: size }, (_, n) => positions[Math.min(positions.length - 1, Math.floor(n / 2))]),
  Float32Array.from({ length: size }, (_, n) => Number(n < positions.length * 2 ? n % 2 === 0 : n === size - 1))];

for (let first = 1; first <= 64; first += 8) {
  test(`clock native seek cycle bounds and snapshot for step counts ${first}..${first + 7}`, async () => {
    const sampleRate = [44100, 48000, 96000][Math.floor((first - 1) / 8) % 3];
    const configs: MusicalClockConfig[] = Array.from({ length: 8 }, (_, n) => first + n).flatMap(steps => [
      { sampleRate, mode: 'free' as const, steps },
      { sampleRate, mode: 'tempo' as const, steps, stepsPerBeat: steps % 2 ? 64 : 1 / 64 },
    ]);
    const processor = defineProcessor(() => {
      const input = audioInput({ channels: 2, name: 'controls' });
      const output = audioOutput({ channels: configs.length * 2, name: 'main' });
      const clocks = configs.map((config, n) => instantiate(musicalClock, config, { name: `clock${n}` }));
      return { process() { forSample(i => {
        clocks.forEach((clock, n) => {
          const r = clock.tick({ rate: f32(0), reset: bool(false), seek: input.ch(1).at(i).gt(0), position: input.ch(0).at(i) });
          output.ch(n * 2).at(i).write(r.step); output.ch(n * 2 + 1).at(i).write(r.phase);
        });
      }); } };
    });
    const render = (start: number, end: number, restore?: Uint8Array) => renderOffline(processor, {
      sampleRate, duration: (end - start - .25) / sampleRate,
      inputs: { controls: controls.map(c => c.slice(start, end)) }, restore,
    });
    const whole = await render(0, size);
    positions.forEach((position, i) => configs.forEach((config, n) => {
      const expected = expectedPosition(position, config.steps), frame = i * 2;
      expect(whole.outputs.main[n * 2][frame], `steps=${config.steps} mode=${config.mode} position=${position}`).toBe(expected.step);
      expect(whole.outputs.main[n * 2 + 1][frame]).toBe(expected.phase);
      expect(whole.outputs.main[n * 2][frame + 1]).toBe(expected.step);
      expect(whole.outputs.main[n * 2 + 1][frame + 1]).toBe(expected.phase);
    }));
    const slots = inspect(whole.state).slots;
    configs.forEach((config, n) => {
      // Final seek is negative tiny: state must remain near the end of the final
      // step, not only report a capped phase while losing its stored position.
      expect(slots[`clock${n}/clock/step`].value).toBe(config.steps - 1);
      const value = slots[`clock${n}/clock/positionScaled`].value as number;
      const threshold = sampleRate * (config.mode === 'tempo' ? 60 : 1) * 2 ** 128;
      expect(value).toBeLessThan(threshold);
      expect(value / threshold).toBeGreaterThan(.99999999999998);
    });
    const split = await render(0, 512), resumed = await render(512, size, split.state);
    whole.outputs.main.forEach((c, n) => expect(resumed.outputs.main[n]).toEqual(c.slice(512)));
    expect(whole.diagnostics.scrubbedSamples).toBe(0);
    expect(resumed.diagnostics.scrubbedSamples).toBe(0);
  });
}
