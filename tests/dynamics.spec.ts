import { test, expect } from 'vitest';
import { audioInput, audioOutput, bool, compile, defineProcessor, f32, forSample, inspect, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { compressorGainDb, dynamics, envelopeFollower, expanderGainDb, type DetectorMode, type DynamicsMode } from '../src/dynamics.js';

const rates = [44100, 48000, 96000];
const fill = (n: number, value = 0) => new Float32Array(n).fill(value);
const rows = (length: number, f: (i: number) => number[]) => {
  const data = Array.from({ length }, (_, i) => f(i));
  return data[0].map((_, ch) => Float32Array.from(data, row => row[ch]));
};
function follower(rate: number, mode: DetectorMode) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 4, name: 'main' }), output = audioOutput({ channels: 1, name: 'main' });
    const unit = instantiate(envelopeFollower, { sampleRate: rate, mode }, { name: 'follower' });
    return { process() { forSample(i => output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), {
      attack: input.ch(1).at(i), release: input.ch(2).at(i), reset: input.ch(3).at(i).gt(0),
    }))); } };
  });
}
function engine(rate: number, operation: DynamicsMode, mode: DetectorMode = 'peak', hysteresisDb = 3) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 13, name: 'main' }), output = audioOutput({ channels: 5, name: 'main' });
    const unit = instantiate(dynamics, { sampleRate: rate, mode, operation, hysteresisDb }, { name: 'fx' });
    return { process() { forSample(i => {
      const c = (n: number) => input.ch(n).at(i);
      const y = unit.tick(c(0), c(1), c(2), c(3), { thresholdDb: c(4), ratio: c(5), kneeDb: c(6), rangeDb: c(7),
        attack: c(8), release: c(9), detectorAttack: c(10), detectorRelease: c(11), reset: c(12).gt(0) });
      [y.left, y.right, y.envelope, y.gain, y.gainDb].forEach((value, ch) => output.ch(ch).at(i).write(value));
    }); } };
  });
}
async function render(p: ReturnType<typeof follower>, rate: number, inputs: Float32Array[], restore?: Uint8Array) {
  const result = await renderOffline(p, { sampleRate: rate, duration: (inputs[0].length - 0.25) / rate, inputs: { main: inputs }, restore });
  expect(result.outputs.main[0].length).toBe(inputs[0].length);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  result.outputs.main.forEach(ch => ch.forEach(value => expect(Number.isFinite(value)).toBe(true)));
  return result;
}
function close(actual: ArrayLike<number>, expected: ArrayLike<number>, abs = 2e-6, relative = 0) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) expect(Math.abs(actual[i] - expected[i]), `sample ${i}: ${actual[i]} vs ${expected[i]}`).toBeLessThanOrEqual(abs + Math.abs(expected[i]) * relative);
}
function ballistics(signal: Float32Array, attack: Float32Array, release: Float32Array, reset: Float32Array, rate: number, rms = false) {
  let value = 0;
  return Float64Array.from(signal, (sample, n) => {
    if (reset[n] > 0) value = 0;
    const magnitude = Math.abs(Number.isFinite(sample) ? sample : 0), target = rms ? magnitude ** 2 : magnitude;
    let time = target > value ? attack[n] : release[n];
    time = Number.isFinite(time) ? Math.max(0, Math.min(30, time)) : 0;
    const coefficient = time === 0 ? 1 : -Math.expm1(-1 / Math.max(1, rate * time));
    value += (target - value) * coefficient;
    return rms ? Math.sqrt(value) : value;
  });
}
const db = (amplitude: number) => 20 * Math.log10(Math.max(1e-30, amplitude));
function staticGain(level: number, threshold: number, ratio: number, knee: number, range: number, expand = false) {
  // Independent input/output transfer curve; subtracting input obtains gain.
  let output: number;
  const difference = level - threshold;
  if (expand) {
    if (difference >= knee / 2) output = level;
    else if (difference <= -knee / 2) output = threshold + difference * ratio;
    else output = level - (ratio - 1) * (difference - knee / 2) ** 2 / (2 * knee);
  } else {
    if (difference <= -knee / 2) output = level;
    else if (difference >= knee / 2) output = threshold + difference / ratio;
    else output = level + (1 / ratio - 1) * (difference + knee / 2) ** 2 / (2 * knee);
  }
  return Math.max(-range, Math.min(0, output - level));
}

for (const rate of rates) for (const mode of ['peak', 'rms'] as const) {
  test(`${mode} detector independent steps, burst, a-rate time edits and reset at ${rate}`, async () => {
    const inputs = rows(2048, n => [n < 500 ? -0.75 : n < 1000 ? 0 : n < 1400 ? 0.25 : Math.sin(n * 0.2),
      n < 1024 ? 0.002 : 0, n < 1500 ? 0.007 : 30, n === 129 || n === 1537 ? 1 : 0]);
    const result = await render(follower(rate, mode), rate, inputs);
    close(result.outputs.main[0], ballistics(inputs[0], inputs[1], inputs[2], inputs[3], rate, mode === 'rms'));
  });
  test(`${mode} detector tiny/subnormal/full-range input and nonfinite recovery at ${rate}`, async () => {
    for (const amplitude of [2 ** -149, 1e-35, 1e-20, 0, 1, 3.4028234663852886e38]) {
      const inputs = [fill(256, amplitude), fill(256, 0.001), fill(256, 0.005), fill(256)];
      const result = await render(follower(rate, mode), rate, inputs);
      close(result.outputs.main[0], ballistics(inputs[0], inputs[1], inputs[2], inputs[3], rate, mode === 'rms'), 2 ** -149, 3e-7);
      if (amplitude > 0) expect(result.outputs.main[0][255]).toBeGreaterThan(0);
    }
    const inputs = rows(256, n => [[NaN, Infinity, -Infinity, 0.5][n % 4], n % 3 ? 0 : NaN, 0, 0]);
    const actual = (await render(follower(rate, mode), rate, inputs)).outputs.main[0];
    close(actual, Array.from(inputs[0], x => Number.isFinite(x) ? Math.abs(x) : 0));
  });
  test(`${mode} detector same-schema snapshot, instance state and zero/subsample times at ${rate}`, async () => {
    const p = follower(rate, mode);
    const inputs = rows(512, n => [n < 256 ? 0.6 : 0, n < 64 ? 0 : 0.2 / rate, 0.03, n === 384 ? 1 : 0]);
    const whole = await render(p, rate, inputs), first = await render(p, rate, inputs.map(x => x.slice(0, 128)));
    const resumed = await render(p, rate, inputs.map(x => x.slice(128)), first.state);
    expect(resumed.outputs.main[0]).toEqual(whole.outputs.main[0].slice(128));
    close(whole.outputs.main[0], ballistics(inputs[0], inputs[1], inputs[2], inputs[3], rate, mode === 'rms'));
    expect(Object.keys(inspect(whole.state).slots)).toHaveLength(2);
    expect(whole.outputs.main[0][0]).toBeCloseTo(0.6, 6);
    expect(whole.outputs.main[0][384]).toBe(0);
  });
}

test('static compressor/expander transfer curve, threshold, knee continuity, range and ratio one', async () => {
  const p = defineProcessor(() => {
    const input = audioInput({ channels: 5, name: 'main' }), output = audioOutput({ channels: 2, name: 'main' });
    return { process() { forSample(i => {
      const c = { thresholdDb: input.ch(1).at(i), ratio: input.ch(2).at(i), kneeDb: input.ch(3).at(i), rangeDb: input.ch(4).at(i) };
      output.ch(0).at(i).write(compressorGainDb(input.ch(0).at(i), c));
      output.ch(1).at(i).write(expanderGainDb(input.ch(0).at(i), c));
    }); } };
  });
  for (const knee of [0, 6, 24, 48]) for (const ratio of [1, 2, 4, 100]) {
    const inputs = rows(512, n => [-144 + n / 2, -24, ratio, knee, 48]);
    const result = await render(p, 48000, inputs);
    for (const expand of [false, true]) close(result.outputs.main[expand ? 1 : 0], Array.from(inputs[0], x => staticGain(x, -24, ratio, knee, 48, expand)), 5e-6);
  }
});

for (const rate of rates) for (const operation of ['compressor', 'expander', 'gate', 'duck'] as const) {
  test(`${operation} linked stereo, external sidechain, gain timing and snapshot at ${rate}`, async () => {
    const p = engine(rate, operation);
    const inputs = rows(1024, n => [0.5, -0.125, n < 128 || n >= 640 ? 0 : 0.8, 0, -12, 4, 6, 36, 0.003, 0.007, 0, 0, 0]);
    const result = await render(p, rate, inputs);
    let active = false, attenuation = 0;
    const expected = Array.from(inputs[0], (_, n) => {
      const level = db(inputs[2][n]);
      active = level >= -12 || active && level > -15;
      const target = operation === 'compressor' ? -staticGain(level, -12, 4, 6, 36) : operation === 'expander' ? -staticGain(level, -12, 4, 6, 36, true) : (operation === 'duck' ? active : !active) ? 36 : 0;
      const opens = operation === 'gate' || operation === 'expander';
      const time = target > attenuation ? inputs[opens ? 9 : 8][n] : inputs[opens ? 8 : 9][n];
      attenuation += (target - attenuation) * -Math.expm1(-1 / (rate * time));
      return attenuation;
    });
    close(result.outputs.main[4], expected.map(x => -x), 8e-5);
    close(result.outputs.main[3], expected.map(x => 10 ** (-x / 20)), 4e-6);
    for (let n = 0; n < 1024; n++) expect(result.outputs.main[0][n]).toBe(-4 * result.outputs.main[1][n]);
    const swapped = await render(p, rate, [inputs[0], inputs[1], inputs[3], inputs[2], ...inputs.slice(4)]);
    expect(swapped.outputs.main).toEqual(result.outputs.main);
    const first = await render(p, rate, inputs.map(x => x.slice(0, 512)));
    const resumed = await render(p, rate, inputs.map(x => x.slice(512)), first.state);
    result.outputs.main.forEach((ch, i) => expect(resumed.outputs.main[i]).toEqual(ch.slice(512)));
  });
}

test('invalid configuration rejects before audio capture', () => {
  for (const rate of [0, 7999, 192001, NaN, Infinity, 48000.5]) expect(() => follower(rate, 'peak')).toThrow(/sampleRate/);
  expect(() => follower(48000, 'invalid' as DetectorMode)).toThrow(/mode/);
  expect(() => engine(48000, 'invalid' as DynamicsMode)).toThrow(/operation/);
  for (const hysteresis of [-1, 25, NaN, Infinity]) expect(() => engine(48000, 'gate', 'peak', hysteresis)).toThrow(/hysteresis/);
});

for (const mode of ['peak', 'rms'] as const) test(`${mode} detector preserves tiny values after a large instantaneous step`, async () => {
  const inputs = rows(256, n => [n % 2 ? 1e-35 : 1e30, 0, 0, 0]);
  const result = await render(follower(48000, mode), 48000, inputs);
  expect(result.outputs.main[0]).toEqual(inputs[0]);
});

for (const operation of ['gate', 'duck'] as const) test(`${operation} hysteresis, exact unity threshold, reset and zero gain times`, async () => {
  const keyDb = [-6, 0, -1, -2.9, -3.1, -1, 0, -1];
  const input = rows(256, n => [0.5, 0.25, 10 ** (keyDb[Math.floor(n / 32)] / 20), 0, 0, 4, 0, 40, 0, 0, 0, 0, n === 240 ? 1 : 0]);
  const result = await render(engine(48000, operation), 48000, input);
  const active = [false, true, true, true, false, false, true, true];
  for (let n = 0; n < 256; n++) {
    const on = n >= 240 ? false : active[Math.floor(n / 32)];
    const reduction = (operation === 'duck' ? on : !on) ? 40 : 0;
    expect(result.outputs.main[4][n]).toBe(-reduction);
    expect(Math.abs(result.outputs.main[3][n] - 10 ** (-reduction / 20))).toBeLessThan(2e-6);
  }
});

for (const operation of ['compressor', 'expander', 'gate', 'duck'] as const) test(`${operation} malformed controls/input recover without scrub or channel leakage`, async () => {
  const input = rows(512, n => [n % 7 === 0 ? NaN : 0.5, n % 11 === 0 ? Infinity : -0.5, n % 17 === 0 ? -Infinity : 1,
    n % 19 === 0 ? NaN : 0, n % 13 === 0 ? NaN : -24, n % 5 ? 1e20 : -1e20, n % 3 ? 1e20 : -1e20,
    n % 31 ? 1e20 : NaN, n % 3 ? Infinity : -1, n % 5 ? NaN : 30, n % 7 ? 0 : Infinity, 0, n === 256 ? 1 : 0]);
  const result = await render(engine(48000, operation), 48000, input);
  result.outputs.main[3].forEach(g => expect(g).toBeGreaterThanOrEqual(0));
  result.outputs.main[3].forEach(g => expect(g).toBeLessThanOrEqual(1));
  for (let n = 0; n < 512; n++) {
    if (!Number.isFinite(input[0][n])) expect(result.outputs.main[0][n]).toBe(0);
    if (!Number.isFinite(input[1][n])) expect(result.outputs.main[1][n]).toBe(0);
  }
});

test('RMS power average approaches sine RMS; release and tiny 30-second attacks remain active', async () => {
  const rate = 48000, n = 32768;
  const signal = Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 1000 * i / rate));
  const result = await render(follower(rate, 'rms'), rate, [signal, fill(n, 0.05), fill(n, 0.05), fill(n)]);
  expect(Math.abs(result.outputs.main[0][n - 1] - Math.SQRT1_2)).toBeLessThan(0.002);
  for (const mode of ['peak', 'rms'] as const) {
    const input = [fill(256, 1e-35), fill(256, 30), fill(256, 30), fill(256)];
    const output = (await render(follower(rate, mode), rate, input)).outputs.main[0];
    close(output, ballistics(input[0], input[1], input[2], input[3], rate, mode === 'rms'), 2 ** -149, 3e-7);
    expect(output[255]).toBeGreaterThan(output[127]);
  }
});

test('fixed state and bounded compiled artifact for every operation', async () => {
  for (const operation of ['compressor', 'expander', 'gate', 'duck'] as const) {
    const p = engine(48000, operation, 'rms');
    const compiled = await compile(p, { sampleRate: 48000 });
    expect(compiled.wasm.byteLength).toBeLessThan(64000);
    const data = rows(128, () => [0.5, -0.5, 0.5, -0.5, -12, 4, 6, 60, 0.003, 0.1, 0.001, 0.01, 0]);
    const a = await render(p, 48000, data), b = await render(p, 48000, data, a.state);
    expect(Object.keys(inspect(a.state).slots)).toHaveLength(7);
    expect(a.state.byteLength).toBe(b.state.byteLength);
  }
});

for (const rate of [8000, 192000]) test(`documented rate endpoint, zero latency and non-limiter overshoot at ${rate}`, async () => {
  const input = rows(256, n => [n === 0 ? 1 : 0, 0, n === 0 ? 1 : 0, 0, -24, 100, 0, 120, 0.01, 0.1, 0, 0, 0]);
  const result = await render(engine(rate, 'compressor'), rate, input);
  // Causality: audio arrives on the input sample. Finite attack intentionally
  // permits overshoot, so this processor must never be described as a limiter.
  expect(result.outputs.main[0][0]).toBeGreaterThan(0.9);
  expect(result.outputs.main[0].slice(1)).toEqual(fill(255));
  expect(10 ** (staticGain(0, -24, 100, 0, 120) / 20)).toBeLessThan(0.1);
});

test('independent instances, delayed consumption and tiny RMS snapshot continuation', async () => {
  const p = defineProcessor(() => {
    const input = audioInput({ channels: 2, name: 'main' }), output = audioOutput({ channels: 2, name: 'main' });
    const a = instantiate(envelopeFollower, { sampleRate: 48000, mode: 'rms' }, { name: 'a' });
    const b = instantiate(envelopeFollower, { sampleRate: 48000, mode: 'peak' }, { name: 'b' });
    return { process() { forSample(i => {
      const controls = { attack: f32(0.001), release: f32(0.02), reset: bool(false) };
      const x = a.tick(input.ch(0).at(i), controls), y = b.tick(input.ch(1).at(i), controls);
      output.ch(0).at(i).write(x); output.ch(1).at(i).write(y);
    }); } };
  });
  const inputs = [fill(512, 1e-35), fill(512)];
  const whole = await render(p, 48000, inputs), first = await render(p, 48000, inputs.map(x => x.slice(0, 128)));
  const resumed = await render(p, 48000, inputs.map(x => x.slice(128)), first.state);
  expect(whole.outputs.main[1]).toEqual(fill(512));
  expect(resumed.outputs.main[0]).toEqual(whole.outputs.main[0].slice(128));
  expect(whole.outputs.main[0][511]).toBeGreaterThan(0);
  close(whole.outputs.main[0], ballistics(inputs[0], fill(512, 0.001), fill(512, 0.02), fill(512), 48000, true), 2 ** -149, 3e-7);
  expect(Object.keys(inspect(whole.state).slots)).toHaveLength(4);
});
