import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import * as core from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { captureTypeFiles } from '../type-files.mjs';
import { createTypeProject } from '../src/typescript-project.ts';
import { evaluateSource } from '../src/evaluate-source.ts';
const group = process.argv[2] ?? 'source-control';
if (!['effects', 'source-control', 'extra'].includes(group)) throw new Error('Unknown example group');
const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', group);
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
const start = Number(process.argv[3] ?? 0), end = Number(process.argv[4] ?? manifest.length);
const reportPath = join(directory, `_validation-${start}-${end}-${Date.now()}.json`);
const report = { start, end, sampleRate: 48000, rows: [], limitations: 'Native offline validation only; no browser, human listening, or general realtime acceptance claim. MIDI note/controller state is transient and is not claimed to restore.' };
const project = createTypeProject(captureTypeFiles());
const beginning = performance.now();
function makeInputs(ports, count, offset = 0) {
  return Object.fromEntries(ports.map(port => [port.name, Array.from({ length: port.channels }, () => Float32Array.from({ length: count }, (_, frame) => {
    const t = (frame + offset) / 48000;
    let sample = 0; for (let h = 1; h <= 8; h++) sample += Math.sin(2 * Math.PI * 220 * h * t) / h;
    return sample * 0.065 * (0.7 + 0.3 * Math.sin(2 * Math.PI * 2 * t));
  }))]));
}
function numericParams(values, count) { return Object.fromEntries(Object.entries(values ?? {}).map(([key, value]) => [key, Array(count).fill(value)])); }
try {
  for (const row of manifest.slice(start, end)) {
    const source = readFileSync(join(directory, row.file), 'utf8');
    project.sync(source); assert.deepEqual(project.diagnostics(), [], `${row.id}: semantic diagnostics`);
    assert(source.includes(`'@denaudio/den${row.module === '.' ? '' : '/' + row.module.slice(2)}'`), `${row.id}: assigned import`);
    console.log('TYPE', row.id);
  }
  for (const entry of manifest.slice(start, end)) {
    const row = { id: entry.id, stage: 'evaluate', sourceSHA256: '' }; report.rows.push(row);
    const source = readFileSync(join(directory, entry.file), 'utf8');
    row.sourceSHA256 = createHash('sha256').update(source).digest('hex');
    const modules = {};
    for (const [, specifier] of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert(specifier === '@unworklet/core' || specifier === '@denaudio/den' || specifier.startsWith('@denaudio/den/'));
      modules[specifier] = await import(specifier);
    }
    const { processor, exports } = evaluateSource(source, modules);
    assert.equal(processor.worklet.outputs.length, 1);
    assert.equal(processor.worklet.outputs[0].name, 'main');
    assert([1, 2].includes(processor.worklet.outputs[0].channels));
    assert(processor.worklet.inputs.every(port => port.name === 'main'));
    row.stage = 'compile'; const compileStart = performance.now();
    const compiled = await core.compile(processor, { sampleRate: 48000 });
    row.compileMs = performance.now() - compileStart; row.wasmBytes = compiled.wasm.length;
    row.inputs = processor.worklet.inputs; row.outputs = processor.worklet.outputs;
    const initial = exports.initial ?? {}, afterReady = exports.afterReady ?? {};
    const messages = exports.events ?? [];
    const midi = (exports.midi ?? []).map(({ port, event }) => ({ name: port, payload: event, atSample: 0 }));
    const frames = 49152;
    let main;
    if (midi.length) {
      row.stage = 'native-midi-render';
      assert.equal(messages.length, 0); assert.equal((exports.ready ?? []).length, 0);
      main = await renderOffline(processor, { sampleRate: 48000, duration: (frames - 0.5) / 48000,
        inputs: makeInputs(processor.worklet.inputs, frames), params: numericParams(initial, frames), events: midi });
      row.midi = exports.midi;
      row.snapshotContinuation = 'Not asserted: note/controller state is native transient state.';
    } else {
      row.stage = 'warm-render';
      const warm = await renderOffline(processor, { sampleRate: 48000, duration: (128 - 0.5) / 48000,
        inputs: makeInputs(processor.worklet.inputs, 128), params: numericParams(initial, 128), messages });
      assert.equal(warm.diagnostics.scrubbedSamples, 0);
      const slots = core.inspect(warm.state).slots; row.readiness = [];
      for (const expected of exports.ready ?? []) {
        const found = Object.entries(slots).filter(([name]) => name.endsWith(expected.suffix));
        assert(found.length > 0, `Missing state ${expected.suffix}`);
        for (const [name, value] of found) {
          assert.equal(value.value, expected.value, `${name}: asset acknowledgement`);
          row.readiness.push({ name, value: value.value });
        }
      }
      row.stage = 'continuation-render';
      main = await renderOffline(processor, { sampleRate: 48000, duration: (frames - 0.5) / 48000,
        inputs: makeInputs(processor.worklet.inputs, frames, 128), params: numericParams({ ...initial, ...afterReady }, frames), restore: warm.state });
      row.stage = 'uninterrupted-reference';
      const total = frames + 128;
      const params = numericParams({ ...initial, ...afterReady }, total);
      for (const key of Object.keys(afterReady)) params[key].fill(initial[key] ?? 0, 0, 128);
      const full = await renderOffline(processor, { sampleRate: 48000, duration: (total - 0.5) / 48000,
        inputs: makeInputs(processor.worklet.inputs, total), params, messages });
      assert.equal(full.diagnostics.scrubbedSamples, 0);
      main.outputs.main.forEach((samples, channel) => assert.deepEqual(samples, full.outputs.main[channel].slice(128), 'Exact same-schema native snapshot continuation'));
      row.snapshotContinuation = 'bit-identical';
    }
    assert.equal(main.diagnostics.scrubbedSamples, 0);
    row.channels = main.outputs.main.map(samples => {
      let peak = 0, energy = 0;
      for (const value of samples) { assert(Number.isFinite(value)); peak = Math.max(peak, Math.abs(value)); energy += value * value; }
      return { peak, rms: Math.sqrt(energy / samples.length) };
    });
    assert(row.channels.some(x => x.peak > 0.005 && x.rms > 0.0005), 'Meaningful nonzero audio');
    assert(row.channels.every(x => x.peak <= 0.35), 'Raw output headroom');
    row.stage = 'passed'; row.scrubbedSamples = 0;
    console.log('PASS', JSON.stringify(row)); writeFileSync(reportPath, JSON.stringify(report, null, 2));
  }
} catch (error) { report.failure = String(error?.stack ?? error); console.error(report.failure); process.exitCode = 1; }
finally { project.dispose(); report.elapsedMs = performance.now() - beginning; report.peakRssBytes = process.resourceUsage().maxRSS * 1024; writeFileSync(reportPath, JSON.stringify(report, null, 2)); console.log('REPORT', reportPath, 'ms', report.elapsedMs, 'peakRSS', report.peakRssBytes); }
