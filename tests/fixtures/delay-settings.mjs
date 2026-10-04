// Dedicated GEN-621 fixture; independent unbounded timeline/biquad oracle.
import assert from 'node:assert/strict';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate, f32 } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { delayFx } from '../../dist/delay-fx.js';
const keys = ['timeLeftSeconds', 'timeRightSeconds', 'sync', 'bpm', 'beatsLeft', 'beatsRight', 'feedback', 'cutoffHz', 'mix', 'rateHz', 'depthSeconds', 'bypass', 'reset'];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function fixture(config, isolation = false) {
    return defineProcessor(ctx => {
        const input = audioInput({ channels: 2, name: 'main' });
        const controls = audioInput({ channels: keys.length, name: 'controls' });
        const output = audioOutput({ channels: isolation ? 6 : 4, name: 'main' });
        const engine = instantiate(delayFx, { ...config, sampleRate: ctx.sampleRate, maxDelaySeconds: config.capacitySamples === undefined ? config.maxDelaySeconds : config.capacitySamples / ctx.sampleRate }, { name: 'engine' });
        const other = isolation ? instantiate(delayFx, { ...config, sampleRate: ctx.sampleRate, maxDelaySeconds: config.capacitySamples === undefined ? config.maxDelaySeconds : config.capacitySamples / ctx.sampleRate }, { name: 'other' }) : null;
        return { process() {
                forSample(i => {
                    const c = Object.fromEntries(keys.map((key, k) => [key, ['sync', 'reset', 'bypass'].includes(key) ? controls.ch(k).at(i).gt(0.5) : controls.ch(k).at(i)]));
                    const result = engine.tick(input.ch(0).at(i), input.ch(1).at(i), c);
                    output.ch(0).at(i).write(result.left);
                    output.ch(1).at(i).write(result.right);
                    output.ch(2).at(i).write(f32(result.timingRejected));
                    output.ch(3).at(i).write(f32(result.modulationClipped));
                    if (other) {
                        const isolated = other.tick(f32(0), f32(0), c);
                        output.ch(4).at(i).write(isolated.left);
                        output.ch(5).at(i).write(isolated.right);
                    }
                });
            } };
    });
}
function inputs(rate, edits = {}, size = 512, left = (n) => n === 0 ? 1 : 0, right = (_n) => 0) {
    const defaults = { timeLeftSeconds: 8 / rate, timeRightSeconds: 12 / rate, sync: 0, bpm: 120, beatsLeft: 1, beatsRight: 1.5, feedback: 0.5, cutoffHz: 1000, mix: 1, rateHz: 0, depthSeconds: 0, bypass: 0, reset: 0 };
    const rows = Array.from({ length: size }, (_, n) => Object.fromEntries(keys.map(key => [key, Math.fround(typeof edits[key] === 'function' ? edits[key](n) : edits[key] ?? defaults[key])])));
    const audio = [Float32Array.from({ length: size }, (_, n) => left(n)), Float32Array.from({ length: size }, (_, n) => right(n))];
    return { rows, audio, ports: { main: audio, controls: keys.map(key => Float32Array.from(rows, row => row[key])) } };
}
async function render(rate, config, data, isolation = false, restore) {
    const result = await renderOffline(fixture(config, isolation), { sampleRate: rate, duration: data.rows.length / rate, inputs: data.ports, restore });
    assert.equal(result.outputs.main[0].length, data.rows.length);
    assert.equal(result.diagnostics.scrubbedSamples, 0);
    return result;
}
function close(actual, expected, tolerance = 3e-6) {
    assert.equal(actual.length, expected.length);
    let worst = 0, index = 0;
    for (let n = 0; n < actual.length; n++) {
        if (!Number.isFinite(actual[n]))
            throw new Error(`nonfinite sample ${n}`);
        const error = Math.abs(actual[n] - expected[n]);
        if (error > worst) {
            worst = error;
            index = n;
        }
    }
    assert.ok(worst <= tolerance, `sample ${index}, actual=${actual[index]}, expected=${expected[index]}, error=${worst}, tolerance=${tolerance}`);
}
// Unbounded written timeline, no circular indices or readhead implementation.
// Static tone uses a direct-form bilinear biquad (not the SVF recurrence).
// Variable tone uses two trapezoidal one-poles in cascade, alternate state
// coordinates p=SVF band+low and q=SVF low, independently evaluated with Math.tan.
function reference(rate, config, data, variableTone = false) {
    const maximum = config.maxDelaySeconds ?? 8, minimum = Math.fround(1 / rate);
    const written = [[], []], out = Array.from({ length: 4 }, () => new Float32Array(data.rows.length));
    const previous = [minimum, minimum], phase = [0, config.stereoPhaseCycles ?? 0.5];
    const filters = Array.from({ length: 2 }, () => ({ x1: 0, x2: 0, y1: 0, y2: 0, p: 0, q: 0 }));
    let start = 0;
    for (let n = 0; n < data.rows.length; n++) {
        const c = data.rows[n], reset = c.reset > 0.5;
        if (reset)
            start = n;
        const requested = c.sync > 0.5 ? [c.beatsLeft, c.beatsRight].map(b => Math.fround(60 * b / clamp(c.bpm, 30, 300))) : [c.timeLeftSeconds, c.timeRightSeconds];
        const within = (x) => x >= minimum && x <= Math.fround(maximum);
        const valid = requested.every(within) && (c.sync <= 0.5 || (c.bpm >= 30 && c.bpm <= 300));
        out[2][n] = valid ? 0 : 1;
        for (let ch = 0; ch < 2; ch++) {
            if (reset || n === 0)
                phase[ch] = ch === 0 ? 0 : (config.stereoPhaseCycles ?? 0.5) % 1;
            const signal = Math.fround(Math.sin(2 * Math.PI * phase[ch]));
            phase[ch] = (phase[ch] + clamp(c.rateHz, 0, 20) / rate) % 1;
            const base = valid ? requested[ch] : reset ? minimum : previous[ch];
            previous[ch] = base;
            const raw = Math.fround(base + Math.fround(signal * clamp(c.depthSeconds, 0, Math.fround(0.05))));
            if (!within(raw))
                out[3][n] = 1;
            const delay = clamp(clamp(raw, minimum, Math.fround(maximum)) * rate, 1, maximum * rate);
            const at = n - delay, lower = Math.floor(at), fraction = at - lower;
            const sample = (index) => index >= start && index < n ? written[ch][index] : 0;
            const wet = Math.fround(sample(lower) * (1 - fraction) + sample(lower + 1) * fraction);
            const s = filters[ch];
            if (reset)
                Object.assign(s, { x1: 0, x2: 0, y1: 0, y2: 0, p: 0, q: 0 });
            const g = Math.tan(Math.PI * clamp(c.cutoffHz, 20, Math.min(20000, 0.24 * rate)) / rate);
            const norm = 1 / (1 + 2 * g + g * g), b0 = g * g * norm;
            let filtered;
            if (variableTone) {
                const u = (s.p + g * wet) / (1 + g), v = (s.q + g * u) / (1 + g);
                s.p = 2 * u - s.p;
                s.q = 2 * v - s.q;
                filtered = Math.fround(v);
            }
            else {
                const y = b0 * (wet + 2 * s.x1 + s.x2) - 2 * (g * g - 1) * norm * s.y1 - (1 - 2 * g + g * g) * norm * s.y2;
                s.x2 = s.x1;
                s.x1 = wet;
                s.y2 = s.y1;
                s.y1 = y;
                filtered = Math.fround(y);
            }
            const dryOnly = !valid || c.bypass > 0.5;
            const feedback = Math.fround((config.tone === 'flat' ? wet : filtered) * Math.fround(clamp(c.feedback, 0, 0.95)));
            written[ch][n] = Math.fround((dryOnly ? 0 : data.audio[ch][n]) + feedback);
            const mix = clamp(c.mix, 0, 1);
            out[ch][n] = dryOnly ? data.audio[ch][n] : data.audio[ch][n] * (1 - mix) + wet * mix;
        }
    }
    return out;
}
export { keys, inputs, render, reference, close };
