import { afterAll, expect, test } from 'vitest';
import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, select } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { oversampledDrive, OVERSAMPLED_DRIVE_LATENCY_SAMPLES, type OversampledDriveConfig } from '../src/oversampled-drive.js';
import { oversampledReference, referenceKernel, filterMagnitude } from './fixtures/oversampled-drive-reference.js';
import { amplitude, aliasResidual, curveValue } from './fixtures/drive-reference.js';
const rates = [44100,48000,96000], curves = ['hard','soft','asymmetric','fold'] as const;
const fill = (n: number, x = 0) => new Float32Array(n).fill(x);
const observations: object[] = [];
afterAll(() => { mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/oversampled-drive-measurements.json', JSON.stringify({ status: 'CANDIDATE', observations }, null, 2)); });
function fixture(config: OversampledDriveConfig) {
  return defineProcessor(() => {
    const input = audioInput({ name: 'main', channels: 4 }), output = audioOutput({ name: 'main', channels: 2 });
    const unit = instantiate(oversampledDrive, config, { name: 'drive' });
    const isolated = instantiate(oversampledDrive, config, { name: 'isolated' });
    return { process() { forSample(i => {
      output.ch(0).at(i).write(unit.tick(input.ch(0).at(i), input.ch(1).at(i), input.ch(2).at(i), input.ch(3).at(i).gt(0)));
      output.ch(1).at(i).write(isolated.tick(f32(0), input.ch(1).at(i), input.ch(2).at(i), bool(false)));
    }); } };
  });
}
function error(a: ArrayLike<number>, b: ArrayLike<number>) {
  expect(a.length).toBe(b.length);
  let maximum = 0; for (let i = 0; i < a.length; i++) maximum = Math.max(maximum, Math.abs(a[i] - b[i])); return maximum;
}
async function render(config: OversampledDriveConfig, input: Float32Array[], restore?: Uint8Array) {
  const result = await renderOffline(fixture(config), { sampleRate: config.sampleRate, duration: input[0].length / config.sampleRate, inputs: { main: input }, restore });
  expect(result.diagnostics.scrubbedSamples).toBe(0); expect(result.outputs.main.every(ch => ch.every(Number.isFinite))).toBe(true);
  expect(result.outputs.main[1].every(x => x === 0)).toBe(true); return result;
}
for (const sampleRate of rates) {
  test(`literal zero-stuff/two-FIR oracle, gain/mix edits and reset at ${sampleRate}`, async () => {
    const n = 1024, input = Float32Array.from({ length: n }, (_, i) => i < 384 ? 2.5 * Math.sin(i * .73) : [-12, 12, 0, .123, -.41][Math.floor(i / 7) % 5]);
    const gain = Float32Array.from(input, (_, i) => i < 384 ? 1 : [0, .5, 4, 32, 100, -1][Math.floor(i / 13) % 6]);
    const mix = Float32Array.from(input, (_, i) => i < 384 ? 1 : [0, .4, 1, 2, -1][Math.floor(i / 11) % 5]);
    const reset = Float32Array.from(input, (_, i) => [0,127,128,129,515,516,901].includes(i) ? 1 : 0), channels = [input,gain,mix,reset];
    for (const factor of [2,4] as const) for (const curve of curves) {
      const output = (await render({ sampleRate, factor, curve }, channels)).outputs.main[0];
      const maximumError = error(output, oversampledReference(channels, factor, curve));
      expect(maximumError).toBeLessThan(2e-6); expect(Math.max(...output.map(Math.abs))).toBeLessThan(15.04);
      expect(error(output, oversampledReference(channels, factor, curve, 1))).toBeGreaterThan(.01); // wrong phase must fail
      observations.push({ sampleRate, factor, curve, check: 'literal-zero-stuff', maximumError });
    }
  }, 180000);
  test(`bulk delay, precursors, matched dry null, reset tail and exact state at ${sampleRate}`, async () => {
    expect(OVERSAMPLED_DRIVE_LATENCY_SAMPLES).toBe(32);
    for (const factor of [2,4] as const) {
      const n = 512, impulse = fill(n); impulse[0] = .25;
      const outputs = [];
      for (const mix of [0,.4,1]) outputs.push((await render({ sampleRate, factor, curve: 'hard' }, [impulse,fill(n,1),fill(n,mix),fill(n)])).outputs.main[0]);
      expect(error(outputs[0],outputs[1])).toBeLessThan(3e-8); expect(error(outputs[0],outputs[2])).toBeLessThan(3e-8);
      const peak = outputs[2].reduce((best, value, i) => Math.abs(value) > Math.abs(outputs[2][best]) ? i : best, 0);
      expect(peak).toBe(32); expect(outputs[2].slice(1,32).some(x => x !== 0)).toBe(true);
      expect(outputs[2].slice(64).every(x => x === 0)).toBe(true);
      for (let i = 0; i <= 64; i++) expect(Math.abs(outputs[2][i] - outputs[2][64-i])).toBeLessThan(3e-8);
      const input = Float32Array.from({ length: 1024 }, (_, i) => .5 * Math.sin(i*.19)), reset = fill(1024); reset[600] = reset[601] = 1;
      const channels = [input,fill(1024,5),fill(1024,.7),reset], config = { sampleRate, factor, curve: 'soft' as const };
      const whole = await render(config,channels), first = await render(config,channels.map(ch=>ch.slice(0,384))), next = await render(config,channels.map(ch=>ch.slice(384)),first.state);
      expect(error(next.outputs.main[0],whole.outputs.main[0].slice(384))).toBe(0);
      expect(error(whole.outputs.main[0],oversampledReference(channels,factor,'soft'))).toBeLessThan(2e-6);
      expect(whole.outputs.main[0][600]).toBe(0); expect(whole.outputs.main[0][601]).toBe(0);
      const fresh = await render(config, channels.map(ch => ch.slice(601,857)));
      expect(error(fresh.outputs.main[0],whole.outputs.main[0].slice(601,857))).toBe(0);
    }
  }, 120000);
  test(`specific folded-alias fixtures and retained fundamental at ${sampleRate}`, async () => {
    const n = 8192;
    for (const curve of curves) for (const bin of [997,1709]) {
      const input = Float32Array.from({ length: n*2 }, (_,i) => 3*Math.sin(2*Math.PI*bin*i/n));
      const direct = Float32Array.from(input.slice(n),x=>curveValue(x,curve)), directAlias = aliasResidual(direct,bin);
      for (const factor of [2,4] as const) {
        const output = (await render({ sampleRate, factor, curve },[input,fill(n*2,1),fill(n*2,1),fill(n*2)])).outputs.main[0].slice(n);
        const folded = aliasResidual(output,bin), improvementDb = 20*Math.log10(directAlias/folded);
        observations.push({ sampleRate,factor,curve,bin,directAliasRms:directAlias,oversampledAliasRms:folded,improvementDb,directFundamental:amplitude(direct,bin),oversampledFundamental:amplitude(output,bin) });
        expect(improvementDb).toBeGreaterThanOrEqual(factor===2 ? 6 : 10);
      }
    }
  }, 180000);
}
test('individual FIR passband/transition/stopband and constant-gain phase ripple', () => {
  for (const factor of [2,4] as const) {
    const h=referenceKernel(factor); expect(h.length).toBe(32*factor+1); expect(h[0]).toBe(0); expect(h.at(-1)).toBe(0);
    for(let i=0;i<h.length;i++) expect(Math.abs(h[i]-h[h.length-1-i])).toBeLessThan(1e-15);
    let passError=0,stopMaximum=0;
    for(let i=0;i<=1000;i++) { passError=Math.max(passError,Math.abs(filterMagnitude(factor,.35*i/1000)-1)); stopMaximum=Math.max(stopMaximum,filterMagnitude(factor,.55+(factor/2-.55)*i/1000)); }
    expect(passError).toBeLessThan(.0002); expect(stopMaximum).toBeLessThan(.0003);
    expect(filterMagnitude(factor,.5)).toBeLessThan(.04);
    const phaseGains=Array.from({length:factor},(_,p)=>factor*h.filter((_,i)=>i%factor===p).reduce((a,b)=>a+b,0));
    expect(Math.max(...phaseGains.map(x=>Math.abs(x-1)))).toBeLessThan(2e-6);
    observations.push({factor,check:'individual-filter',passbandMaxMagnitudeError:passError,stopbandMaximum:stopMaximum,stopbandAttenuationDb:-20*Math.log10(stopMaximum),phaseGains});
  }
});
test('construction validation, graph nonfinite controls and tiny impulse state preserve finite audio', async () => {
  for (const invalid of [{sampleRate:NaN},{sampleRate:7999},{sampleRate:192001},{factor:1},{factor:3},{curve:'unknown'}]) expect(()=>fixture({sampleRate:48000,factor:2,curve:'hard',...invalid} as OversampledDriveConfig)).toThrow();
  for(const factor of [2,4] as const) for(const curve of curves) {
    const processor=defineProcessor(()=>{
      const output=audioOutput({name:'main',channels:2}),tiny=instantiate(oversampledDrive,{sampleRate:48000,factor,curve},{name:'tiny'}),bad=instantiate(oversampledDrive,{sampleRate:48000,factor,curve},{name:'bad'});
      return{process(){forSample(i=>{
        output.ch(0).at(i).write(tiny.tick(select(i.eq(100),f32(-1e-40),f32(0)),f32(32),f32(1),bool(false)));
        const invalid=select(i.lt(32),f32(NaN),select(i.lt(64),f32(Infinity),f32(-Infinity)));
        output.ch(1).at(i).write(bad.tick(invalid,invalid,invalid,i.eq(64)));
      });}};
    });
    const result=await renderOffline(processor,{sampleRate:48000,duration:128/48000});
    expect(result.diagnostics.scrubbedSamples).toBe(0); expect(result.outputs.main.every(ch=>ch.every(Number.isFinite))).toBe(true);
    const x=fill(128);x[100]=Math.fround(-1e-40);
    expect(Array.from(result.outputs.main[0])).toEqual(Array.from(oversampledReference([x,fill(128,32),fill(128,1),fill(128)],factor,curve)));
    expect(result.outputs.main[0].some(x=>x!==0)).toBe(true);
  }
},120000);
