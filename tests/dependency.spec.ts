import { test, expect } from 'vitest';
import { defineProcessor, defineSubgraph, instantiate, audioOutput, forSample, f32, state, inspect } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { expectAudioMatches, expectNoNaN, expectGainAtFreq } from '@unworklet/test';
import { gate } from '../src/gate.js';

const render = (processor: Parameters<typeof renderOffline>[0]) => renderOffline(processor, {sampleRate:48000,duration:128/48000});

test('unworklet numerical helper accepts the independent answer and rejects an incorrect gain', async () => {
  const input = new Float32Array(128).fill(1);
  const result = await renderOffline(gate,{sampleRate:48000,duration:128/48000,inputs:{main:[input]}});
  const expected = input.slice(); expected.fill(0.5); expected[0]=0;
  expectNoNaN(result);
  expectAudioMatches(result,[expected],{tolerance:0});
  expect(()=>expectAudioMatches(result,[input],{tolerance:0})).toThrow();
});

test('reproduce #104 and verify required config plus explicit instance name', async () => {
  const defaulted = defineSubgraph((config: {name:string}={name:'default'})=>({value:()=>f32(config.name.length)}));
  const required = defineSubgraph((config: {name:string})=>({value:()=>f32(config.name.length)}));
  const fixture = (fixed:boolean) => defineProcessor(()=>{
    const output=audioOutput({channels:1,name:'main'});
    const cell=fixed?instantiate(required,{name:'x'},{name:'instance'}):instantiate(defaulted,{name:'x'});
    return {process(){forSample(i=>output.ch(0).at(i).write(cell.value()));}};
  });
  expect((await render(fixture(false))).outputs.main[0][0]).toBe(7);
  expect((await render(fixture(true))).outputs.main[0][0]).toBe(1);
});

test('regression #79: restore skips same-width incompatible slot types', async () => {
  const original=defineProcessor(()=>{const value=state.f32(1).named('value');return {process(){value.write(value.read());}};},{id:'den.repro.schema'});
  const changed=defineProcessor(()=>{const value=state.i32(7).named('value');return {process(){value.write(value.read());}};},{id:'den.repro.schema'});
  const old=await render(original);
  const next=await renderOffline(changed,{sampleRate:48000,duration:128/48000,restore:old.state});
  expect(inspect(next.state).slots.value.value).toBe(7);
});

test('regression #96: exact quantum durations do not render an extra block', async () => {
  const fixture=defineProcessor(()=>{const count=state.i32(0).named('count');return{process(){count.write(count.read().add(1));}};});
  const exact=await renderOffline(fixture,{sampleRate:48000,duration:896/48000});
  expect(inspect(exact.state).slots.count.value).toBe(7);
  const safe=await renderOffline(fixture,{sampleRate:48000,duration:256/48000});
  expect(inspect(safe.state).slots.count.value).toBe(2);
});

test('regression #98: DC gain is not doubled by the frequency-gain helper',()=>{
  const result={outputs:{main:[new Float32Array(128).fill(1)]},sampleRate:48000,events:[],state:new Uint8Array()};
  expectGainAtFreq(result,0,0,0.01);
  expect(()=>expectGainAtFreq(result,0,6.0206,0.01)).toThrow();
  expectAudioMatches(result,[new Float32Array(128).fill(1)],{tolerance:0});
});

test('regression #106: public lang types pass strict checking at ES2023 and ESNext', async()=>{
  const ts=await import('typescript');
  const diagnostics=(target: import('typescript').ScriptTarget)=>{
    const program=ts.createProgram(['tests/probes/lang-types.ts'],{target,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,strict:true,noEmit:true,skipLibCheck:false,types:[]});
    return ts.getPreEmitDiagnostics(program);
  };
  expect(diagnostics(ts.ScriptTarget.ES2023)).toEqual([]);
  expect(diagnostics(ts.ScriptTarget.ESNext)).toEqual([]);
},15000);
