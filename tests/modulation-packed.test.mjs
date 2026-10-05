import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (args, cwd) => execFileSync('npm', ['--cache', join(tmpdir(), 'den-npm-cache'), ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('packed envelope/LFO declarations and offline rendering in an isolated consumer', { timeout: 180000 }, () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-modulation-'));
  cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
  const [pack] = JSON.parse(run(['pack', '--json', '--pack-destination', consumer], root));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  for (const module of ['envelope', 'lfo']) for (const extension of ['js', 'd.ts']) {
    assert(pack.files.some(file => file.path === `dist/${module}.${extension}`));
  }
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
  run(['ci', '--include=dev', '--ignore-scripts'], consumer);
  // Public exports are owned by integration. These file imports prove the packed
  // modules now, without claiming their pending public subpaths already exist.
  writeFileSync(join(consumer, 'modulation-contract.ts'), `
import { instantiate, f32, bool } from '@unworklet/core';
import { envelope, type EnvelopeControls } from '@denaudio/den/envelope';
import { lfo, modulatePitch, modulateCutoff, modulateDelay } from '@denaudio/den/lfo';
export function compose(c: EnvelopeControls) {
  const env = instantiate(envelope, {sampleRate:48000}, {name:'env'});
  const oscillator = instantiate(lfo, {sampleRate:48000}, {name:'lfo'});
  const signal = oscillator.tick(f32(2), bool(false), f32(0));
  return {envelope:env.tick(c), pitch:modulatePitch(f32(440),signal,f32(12),21600),
    cutoff:modulateCutoff(f32(1000),signal,f32(2),20000), delay:modulateDelay(f32(0.02),signal,f32(0.01),1/48000,2)};
}
`);
  run(['exec', '--', 'tsc', '--noEmit', '--strict', '--skipLibCheck', 'false', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'modulation-contract.ts'], consumer);
  writeFileSync(join(consumer, 'modulation-render.mjs'), `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { defineProcessor, instantiate, audioOutput, forSample, f32, bool, select, state } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { envelope } from '@denaudio/den/envelope';
import { lfo } from '@denaudio/den/lfo';
const evidence = [];
for (const sampleRate of [44100,48000,96000]) {
  const processor = defineProcessor(() => {
    const env = instantiate(envelope,{sampleRate},{name:'env'});
    const oscillator = instantiate(lfo,{sampleRate},{name:'lfo'});
    const frame = state.i32(0).named('frame');
    const output = audioOutput({channels:3,name:'main'});
    return {process(){forSample(i=>{
      const e = env.tick({gate:frame.read().lt(128),retrigger:bool(false),reset:bool(false),
        attack:f32(32/sampleRate),decay:f32(32/sampleRate),sustain:f32(0.5),release:f32(32/sampleRate)});
      output.ch(0).at(i).write(e.level);
      output.ch(1).at(i).write(oscillator.tick(f32(20),bool(false),f32(0)));
      output.ch(2).at(i).write(select(e.done,1,0));
      frame.write(frame.read().add(1));
    });}};
  });
  const result = await renderOffline(processor,{sampleRate,duration:256/sampleRate});
  const [envelopeAudio,lfoAudio,done] = result.outputs.main;
  assert.equal(envelopeAudio.length,256);
  for(let n=0;n<256;n++) {
    const expected=n<32?(n+1)/32:n<64?1-0.5*(n-31)/32:n<128?0.5:n<160?0.5*(159-n)/32:0;
    assert(Math.abs(envelopeAudio[n]-expected)<3e-6);
    assert(Math.abs(lfoAudio[n]-Math.sin(2*Math.PI*20*n/sampleRate))<2e-6);
    assert.equal(done[n],n>=159?1:0);
  }
  evidence.push({sampleRate,envelope:Array.from(envelopeAudio),lfo:Array.from(lfoAudio)});
}
writeFileSync('modulation-results.json',JSON.stringify(evidence));
`);
  execFileSync(process.execPath, ['modulation-render.mjs'], { cwd: consumer, stdio: 'pipe' });
  const evidence = JSON.parse(readFileSync(join(consumer, 'modulation-results.json'), 'utf8'));
  const dir = join(root, 'artifacts', 'modulation'); mkdirSync(dir, { recursive: true });
  const files = {};
  for (const result of evidence) for (const module of ['envelope', 'lfo']) {
    const filename = `candidate-${module}-${result.sampleRate}`;
    const samples = result[module];
    const raw = Buffer.alloc(samples.length * 4); samples.forEach((value, i) => raw.writeFloatLE(value, 4 * i));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 768 240"><title>CANDIDATE ${module} ${result.sampleRate} Hz</title><path fill="none" stroke="black" d="${samples.map((value, i) => `${i === 0 ? 'M' : 'L'}${i * 3},${120 - value * 100}`).join(' ')}"/></svg>`;
    for (const [extension, bytes] of [['f32le', raw], ['svg', svg]]) {
      const file = `${filename}.${extension}`; writeFileSync(join(dir, file), bytes); files[file] = hash(bytes);
    }
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    status: 'CANDIDATE', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '',
    sourceHashes: Object.fromEntries(['src/envelope.ts','src/lfo.ts','tests/envelope.spec.ts','tests/lfo.spec.ts','tests/modulation-packed.test.mjs','package-lock.json'].map(file => [file, hash(readFileSync(join(root, file)))])),
    packageIntegrity: pack.integrity, consumerLockHash: hash(readFileSync(join(consumer, 'package-lock.json'))),
    unworklet: '0.4.1', offlineSampleRates: [44100,48000,96000], samples: 256, format: 'mono f32 little-endian',
    settings: { envelope: { gate: 'on at 0, off at 128', retrigger: false, reset: false, attackFrames: 32, decayFrames: 32, sustain: 0.5, releaseFrames: 32 }, lfo: { rate: 20, reset: false, initialPhase: 0 } },
    input: null, midi: [], seed: null, preset: null, files,
    verification: 'independent piecewise linear ADSR and Math.sin references; exact completion sample; isolated strict TypeScript consumer',
    limitations: ['Not human approved', 'Public subpath exports pending integration; packed file imports used', 'Module offline proof; browser gate remains 48000 Hz only'],
  }, null, 2));
});
