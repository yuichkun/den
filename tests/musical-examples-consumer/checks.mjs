import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderOffline, encodeWav } from '@unworklet/offline';
import { expectedTable, expectedGrainAsset, glassReference, hitReference, grainReference, echoReference } from './reference.mjs';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = data => Buffer.from(data.buffer, data.byteOffset, data.byteLength);
const quantum = (seconds, rate) => Math.ceil(seconds * rate / 128) * 128;
const duration = (frames, rate) => (frames - .25) / rate;
const range = (n, fn) => Array.from({ length: n }, (_, i) => Math.fround(fn(i)));
export function metrics(channels) {
  let peak = 0, energy = 0, count = 0, nonfinite = 0, clipped = 0;
  for (const data of channels) for (const x of data) {
    if (!Number.isFinite(x)) nonfinite++; else { peak = Math.max(peak, Math.abs(x)); energy += x * x; }
    if (Math.abs(x) >= 1) clipped++; count++;
  }
  return { peak, rms: Math.sqrt(energy / count), headroomDb: peak === 0 ? null : -20 * Math.log10(peak), nonfinite, clipped };
}
export function assertHealthy(result, ceiling = .5) {
  assert.equal(result.diagnostics.scrubbedSamples, 0);
  const m = metrics(result.outputs.main);
  assert.equal(m.nonfinite, 0); assert.equal(m.clipped, 0); assert(m.peak < ceiling, `peak ${m.peak} >= ${ceiling}`);
  return m;
}
export function compare(actual, expected, tolerance = 5e-6) {
  assert.equal(actual.length, expected.length); let error = 0, worst = 0;
  actual.forEach((ch, c) => { assert.equal(ch.length, expected[c].length); for (let n = 0; n < ch.length; n++) {
    const e = Math.abs(ch[n] - expected[c][n]); if (e > error) { error = e; worst = n; }
  } });
  assert(error < tolerance, `independent error ${error} at sample ${worst} exceeds ${tolerance}`);
  return error;
}
export function fixture(lib, name, variant, rate) {
  const key = { glassDyad: ['glassDyadParameters', 'glassDyadBrightParameters'], fmModalHit: ['fmModalHitParameters', 'fmModalHitBellParameters'],
    grainCloud: ['grainCloudParameters', 'grainCloudReverseParameters'], shapedEcho: ['shapedEchoParameters', 'shapedEchoDarkParameters'] }[name][variant];
  const settings = lib[key], length = quantum(name === 'shapedEcho' ? 2.75 : name === 'fmModalHit' ? 1.5 : 1.2, rate);
  const params = Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, range(length, () => v)]));
  const q = seconds => quantum(seconds, rate), start = 128;
  let data, inputs, lastInput, silentAt;
  if (name === 'glassDyad') {
    data = lib.makeGlassDyadTable();
    params.gateA = range(length, n => +(n >= start && n < q(.4)));
    params.gateB = range(length, n => +(n >= 384 && n < q(.5)));
    params.frequencyA = range(length, n => n < q(.3) ? settings.frequencyA : 277.1826309768721);
    params.frame = range(length, n => n < q(.24) ? settings.frame : variant === 0 ? 1.25 : .75);
    lastInput = q(.5); silentAt = lastInput + Math.round(Math.fround(.28) * rate);
  } else if (name === 'fmModalHit') {
    const hits = [start, q(.28), q(.56)], hold = q(.1);
    params.gate = range(length, n => +hits.some(t => n >= t && n < t + hold));
    lastInput = hits.at(-1); silentAt = null;
  } else if (name === 'grainCloud') {
    data = lib.makeGrainCloudSample();
    params.gate = range(length, n => +(n >= start && n < q(.65)));
    // The change is audible only to newly launched grains, not existing grains.
    params.positionFrames = range(length, n => n < q(.32) ? settings.positionFrames : variant === 0 ? 1536 : 3500);
    lastInput = q(.65); silentAt = lastInput + Math.round(Math.fround(settings.durationSeconds) * rate);
  } else {
    lastInput = q(.45); silentAt = null;
    const signal = Float32Array.from({ length }, (_, n) => {
      if (n < start || n >= lastInput) return 0;
      const t = (n - start) / rate, contour = Math.min(1, t / .01) * Math.min(1, (lastInput - n) / (.03 * rate));
      return contour * (.28 * Math.sin(2 * Math.PI * 220 * t) + .12 * Math.sin(2 * Math.PI * 660 * t));
    });
    inputs = { main: [signal] };
    params.drive = range(length, n => n < q(.2) ? settings.drive : settings.drive + .5);
  }
  const messages = data ? [{ name: 'load', payload: { data }, atQuantum: 0 }] : [];
  return { name, variant: variant === 0 ? 'A' : 'B', settings, params, length, sampleRate: rate, data, inputs, messages, lastInput, silentAt };
}
function expected(f) {
  if (f.name === 'glassDyad') return glassReference(f.params, f.sampleRate, f.length);
  if (f.name === 'fmModalHit') return hitReference(f.params, f.sampleRate, f.length);
  if (f.name === 'grainCloud') return grainReference(f.params, f.sampleRate, f.length);
  return echoReference(f.params, f.sampleRate, f.inputs.main[0]);
}
function options(f, from = 0, to = f.length) {
  return { sampleRate: f.sampleRate, duration: duration(to - from, f.sampleRate),
    params: Object.fromEntries(Object.entries(f.params).map(([k, values]) => [k, values.slice(from, to)])),
    inputs: f.inputs && Object.fromEntries(Object.entries(f.inputs).map(([k, channels]) => [k, channels.map(x => x.slice(from, to))])),
    messages: from === 0 ? f.messages : [],
  };
}
export async function checkExample(lib, f, { save, onAudio, snapshots = true, repeat = true } = {}) {
  const processor = lib[f.name], rendered = await renderOffline(processor, options(f));
  assert.equal(rendered.outputs.main.length, 2); assert.equal(rendered.outputs.main[0].length, f.length);
  if (onAudio) onAudio(rendered.outputs.main);
  const measured = assertHealthy(rendered), reference = expected(f), error = compare(rendered.outputs.main, reference);
  assert(measured.rms > .001, `${f.name} unexpectedly silent`);
  assert(rendered.outputs.main.every(ch => ch.slice(0, 128).every(x => x === 0)), 'preload/pre-gate silence');
  const tail = metrics(rendered.outputs.main.map(ch => ch.slice(-quantum(.1, f.sampleRate))));
  assert(tail.peak < 5e-6, `end tail too loud: ${tail.peak}`);
  if (f.silentAt !== null) assert(rendered.outputs.main.every(ch => ch.slice(f.silentAt).every(x => x === 0)), 'exact source completion');
  if (repeat) {
    const again = await renderOffline(processor, options(f)); assert.deepEqual(again.outputs.main, rendered.outputs.main); assertHealthy(again);
  }
  let split;
  if (snapshots) {
    split = quantum(.21, f.sampleRate);
    const first = await renderOffline(processor, options(f, 0, split));
    const rest = await renderOffline(processor, { ...options(f, split), restore: first.state });
    assert.deepEqual(rest.outputs.main, rendered.outputs.main.map(ch => ch.slice(split)), 'same-schema live continuation including loaded PCM/history');
    assertHealthy(first); assertHealthy(rest);
  }
  // Wrong signal controls must fail the same checks used above.
  assert.throws(() => compare(rendered.outputs.main.map(ch => Float32Array.from(ch, x => x * .5)), reference));
  assert.throws(() => assertHealthy({ diagnostics: { scrubbedSamples: 0 }, outputs: { main: [Float32Array.of(1)] } }));
  assert.throws(() => assertHealthy({ diagnostics: { scrubbedSamples: 0 }, outputs: { main: [Float32Array.of(NaN)] } }));
  const name = `candidate-${f.name}-${f.variant}-${f.sampleRate}`, wav = encodeWav(rendered.outputs.main, f.sampleRate, { bitDepth: '32f' });
  const trace = { name: f.name, variant: f.variant, sampleRate: f.sampleRate, frames: f.length, settings: f.settings,
    params: f.params, messageTimeline: f.messages.map(m => ({ name: m.name, atQuantum: m.atQuantum, frames: m.payload.data.length, pcmSHA256: hash(bytes(m.payload.data)) })),
    inputs: f.inputs ? Object.fromEntries(Object.entries(f.inputs).map(([k, channels]) => [k, channels.map(ch => ({ frames: ch.length, sha256: hash(bytes(ch)) }))])) : {},
    lastInput: f.lastInput, exactSilenceAt: f.silentAt, snapshotSplit: split ?? null };
  const traceJSON = JSON.stringify(trace);
  if (save) { save(`${name}.wav`, wav); save(`${name}.json`, traceJSON); }
  return { name: f.name, variant: f.variant, rate: f.sampleRate, frames: f.length, measured, tail, maximumReferenceError: error,
    finalGain: f.settings.gain, inferredPreGainPeak: measured.peak / Math.fround(f.settings.gain),
    traceSHA256: hash(traceJSON), assetSHA256: f.data ? hash(bytes(f.data)) : null,
    pcmSHA256: rendered.outputs.main.map(ch => hash(bytes(ch))), wavSHA256: hash(wav), snapshotBytes: rendered.state.byteLength,
    exactSilenceAt: f.silentAt, snapshotVerified: snapshots, repeatVerified: repeat };
}
export function checkMaterials(lib) {
  assert.equal(lib.musicalMaterialsStatus, 'CANDIDATE');
  assert.deepEqual(lib.glassDyadParameters, { gateA: 0, gateB: 0, frequencyA: 220, frequencyB: 330, frame: .25, gain: .2, reset: 0 });
  assert.deepEqual(lib.fmModalHitParameters, { gate: 0, strength: .8, ratio: 1.5, deviationHz: 100, modalMix: .35, gain: .22, reset: 0 });
  assert.deepEqual(lib.grainCloudParameters, { gate: 0, positionFrames: 512, jitterFrames: 240, rate: 1, durationSeconds: .09, densityHz: 16, gain: .28, reset: 0 });
  assert.deepEqual(lib.shapedEchoParameters, { drive: 2.4, cutoffHz: 1800, delaySeconds: .125, feedback: .25, mix: .3, gain: .2, reset: 0 });
  assert.deepEqual(lib.glassDyadConstruction, { voices: 2, frameLength: 128, frameCount: 3, capacity: 384 });
  assert.deepEqual(lib.grainCloudConstruction, { capacity: 4096, sourceSampleRate: 48000, maxGrains: 2, seed: 1741 });
  compare([lib.makeGlassDyadTable()], [expectedTable()], 1e-7);
  compare([lib.makeGrainCloudSample()], [expectedGrainAsset()], 1e-7);
  assert(metrics([lib.makeGlassDyadTable()]).peak <= .8 + 1e-7);
  assert(metrics([lib.makeGrainCloudSample()]).peak <= .57 + 1e-7);
  for (const name of ['glassDyad', 'fmModalHit', 'grainCloud', 'shapedEcho']) {
    const a = fixture(lib, name, 0, 48000), b = fixture(lib, name, 1, 48000);
    assert.deepEqual(Object.keys(a.settings), Object.keys(b.settings)); assert.notDeepEqual(a.settings, b.settings);
  }
}
export async function checkResetAndAssets(lib, name, rate = 48000) {
  const f = fixture(lib, name, 0, rate), length = 2048;
  f.length = length; f.params = Object.fromEntries(Object.entries(f.params).map(([k, values]) => [k, values.slice(0, length)]));
  f.params.reset = range(length, n => +(n >= 1024 && n < 1280));
  if (f.inputs) f.inputs.main[0] = new Float32Array(length).fill(.1);
  const r = await renderOffline(lib[name], options(f)); assertHealthy(r);
  assert(r.outputs.main.every(ch => ch.slice(1024, 1280).every(x => x === 0)), 'held reset must mute every output');
  const resetState = await renderOffline(lib[name], { ...options(f), params: { ...f.params, reset: [1] } });
  assert(resetState.outputs.main.every(ch => ch.every(x => x === 0)));
  // A fresh render and a reset-restored render both restart on the same timeline.
  const start = fixture(lib, name, 0, rate); start.length = length;
  start.params = Object.fromEntries(Object.entries(start.params).map(([k, values]) => [k, values.slice(0, length)]));
  start.params.reset[0] = 1;
  if (start.inputs) start.inputs.main[0] = start.inputs.main[0].slice(0, length);
  const cold = await renderOffline(lib[name], options(start));
  const restarted = await renderOffline(lib[name], { ...options(start), restore: r.state });
  assert.deepEqual(restarted.outputs.main, cold.outputs.main, 'reset-restored and cold fixture');
  if (name === 'glassDyad' || name === 'grainCloud') {
    const missing = await renderOffline(lib[name], { ...options(f), messages: [] });
    assert(missing.outputs.main.every(ch => ch.every(x => x === 0)), 'missing asset is silent');
    const replaced = await renderOffline(lib[name], { ...options(f), messages: [
      ...f.messages, { name: 'load', payload: { data: new Float32Array() }, atQuantum: 4 },
      { name: 'load', payload: { data: f.data }, atQuantum: 6 },
    ] });
    assert(replaced.outputs.main.every(ch => ch.slice(512, 768).every(x => x === 0)), 'unloaded asset cannot leak stale PCM');
    assertHealthy(replaced);
    if (name === 'glassDyad') {
      const short = await renderOffline(lib[name], { ...options(f), messages: [...f.messages,
        { name: 'load', payload: { data: f.data.slice(0, 383) }, atQuantum: 4 }] });
      assert(short.outputs.main.every(ch => ch.slice(512).every(x => x === 0)), 'incomplete morph bank must be missing, not leak old final frame');
    }
  }
}
