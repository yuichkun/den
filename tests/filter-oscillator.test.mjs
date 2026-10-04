import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, npm_config_cache: join(tmpdir(), 'den-npm-cache') } });

test('packed DSP files render in an isolated locked consumer; capture candidate provenance', { timeout: 120000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-dsp-'));
  for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'tests/consumer', name), join(consumer, name));
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  for (const file of ['filter', 'oscillator']) for (const ext of ['js', 'd.ts']) assert(pack.files.some(f => f.path === `dist/${file}.${ext}`));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  // Use shipped module paths pending the separately coordinated root export patch.
  writeFileSync(join(consumer, 'dsp.ts'), `
import { filter } from './node_modules/@denaudio/den/dist/filter.js';
import { oscillator } from './node_modules/@denaudio/den/dist/oscillator.js';
import { defineProcessor, audioOutput, instantiate, forSample, f32, bool } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { writeFileSync } from 'node:fs';
for (const sampleRate of [44100, 48000, 96000]) {
  const processor = defineProcessor(() => {
    const source = instantiate(oscillator, { sampleRate, waveform: 'sine' }, { name: 'source' });
    const tone = instantiate(filter, { sampleRate }, { name: 'tone' });
    const output = audioOutput({ channels: 1, name: 'main' });
    return { process() { forSample(i => output.ch(0).at(i).write(tone.tick(source.tick(f32(440), bool(false)), f32(1000), f32(Math.SQRT1_2), bool(false)))); } };
  });
  const result = await renderOffline(processor, { sampleRate, duration: 4096 / sampleRate });
  const audio = result.outputs.main[0];
  if (audio.length !== 4096 || !audio.every(Number.isFinite)) throw new Error('invalid render');
  // Separate direct-form oracle, driven by analytic sine with sample-zero phase.
  const w = 2*Math.PI*1000/sampleRate, q = Math.fround(Math.SQRT1_2), a0 = 1+Math.sin(w)/(2*q);
  const b0=(1-Math.cos(w))/2/a0, a1=-2*Math.cos(w)/a0, a2=(1-Math.sin(w)/(2*q))/a0;
  let x1=0,x2=0,y1=0,y2=0;
  for(let i=0;i<audio.length;i++) {
    const x=Math.fround(Math.sin(2*Math.PI*440*i/sampleRate));
    const y=b0*x+2*b0*x1+b0*x2-a1*y1-a2*y2;
    if(Math.abs(audio[i]-y)>2e-6) throw new Error('independent oracle mismatch at '+i);
    x2=x1;x1=x;y2=y1;y1=y;
  }
  writeFileSync('candidate-dsp-'+sampleRate+'.f32', new Uint8Array(audio.buffer));
}
`);
  // No Node type dependency: typecheck only the exact public DSP declarations
  // and a separate composition fixture, then execute the Node-supported TS file.
  const composition = readFileSync(join(consumer, 'dsp.ts'), 'utf8').split("import { writeFileSync }")[0];
  writeFileSync(join(consumer, 'types.ts'), composition + `\nconst a = defineProcessor(() => { const x=instantiate(oscillator,{sampleRate:48000,waveform:'saw'},{name:'a'}); const y=instantiate(filter,{sampleRate:48000},{name:'b'}); return {process(){forSample(()=>y.tick(x.tick(f32(55),bool(false)),f32(800),f32(0.5),bool(false)));}}; });\n`);
  run('node', ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'types.ts'], consumer);
  run('node', ['dsp.ts'], consumer);
  const artifacts = join(root, 'artifacts'); mkdirSync(artifacts, { recursive: true });
  const files = {};
  for (const sampleRate of [44100, 48000, 96000]) {
    const name = `candidate-dsp-${sampleRate}.f32`, bytes = readFileSync(join(consumer, name));
    copyFileSync(join(consumer, name), join(artifacts, name)); files[name] = hash(bytes);
    const audio = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    const points = Array.from(audio.slice(0, 512), (x, i) => `${i},${64 - x * 60}`).join(' ');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 128"><title>CANDIDATE 440 Hz sine through 1 kHz low-pass at ${sampleRate} Hz</title><polyline fill="none" stroke="black" points="${points}"/></svg>`;
    writeFileSync(join(artifacts, name + '.svg'), svg); files[name + '.svg'] = hash(svg);
  }
  const sourceFiles = ['src/filter.ts', 'src/oscillator.ts', 'tests/filter-oscillator.spec.ts', 'tests/filter-oscillator.test.mjs', 'package-lock.json'];
  writeFileSync(join(artifacts, 'filter-oscillator-manifest.json'), JSON.stringify({
    status: 'CANDIDATE', sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '',
    sourceHashes: Object.fromEntries(sourceFiles.map(f => [f, hash(readFileSync(join(root, f)))])),
    packageIntegrity: pack.integrity, consumerLockSha256: hash(readFileSync(join(consumer, 'package-lock.json'))), unworklet: '0.4.1', sampleRates: [44100, 48000, 96000], frames: 4096,
    settings: { waveform: 'sine', frequencyHz: 440, initialPhase: 0, cutoffHz: 1000, q: Math.fround(Math.SQRT1_2), initialFilterState: [0, 0], reset: false },
    input: null, midi: [], seed: null, preset: null, format: 'mono IEEE754 f32 native little-endian', files,
    checks: 'packed declarations and isolated offline rendering against analytic sine plus independent direct-form biquad, absolute sample error <2e-6',
    limitations: ['not human approved', 'module-file imports pending integration root exports', 'browser proof remains the separate 48 kHz entry gate'],
  }, null, 2));
});
