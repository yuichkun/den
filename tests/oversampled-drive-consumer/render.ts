import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compile } from '@unworklet/core';
import { renderOffline, encodeWav } from '@unworklet/offline';
import { makeProcessor } from './processor.ts';
import { oversampledReference } from './reference.ts';
const reports: object[] = [];
for (const sampleRate of [44100,48000,96000]) for (const factor of [2,4] as const) for (const curve of ['hard','soft','asymmetric','fold'] as const) {
  const n=8192;
  const input=Float32Array.from({length:n},(_,i)=>i<7936 ? .6*(Math.sin(2*Math.PI*173*i/sampleRate)+.3*Math.sin(2*Math.PI*997*i/sampleRate)) : 0);
  const gain=Float32Array.from(input,(_,i)=>i<4096?6:1+15*(i%257)/256);
  const mix=Float32Array.from(input,(_,i)=>i<4096?1:(i%263)/262);
  const reset=Float32Array.from(input,(_,i)=>[0,127,128,2049,6144,6145].includes(i)?1:0);
  const channels=[input,gain,mix,reset];
  const captured=performance.now(),processor=makeProcessor(factor,curve),captureMs=performance.now()-captured;
  const started=performance.now(),compiled=await compile(processor,{sampleRate}),compileMs=performance.now()-started;
  const driver=await compiled.driver.instantiate(),memoryBytes=driver.memory.buffer.byteLength,actual=new Float32Array(n),times:number[]=[];
  for(let offset=0;offset<n;offset+=128){
    driver.writeInput('main',0,input.slice(offset,offset+128));driver.writeInput('main',1,reset.slice(offset,offset+128));
    driver.writeParam('gain',gain.slice(offset,offset+128));driver.writeParam('mix',mix.slice(offset,offset+128));
    const start=performance.now();driver.process();times.push(performance.now()-start);
    const out=new Float32Array(128);driver.readOutput('main',0,out);actual.set(out,offset);
  }
  const offline=(start:number,end:number,restore?:Uint8Array)=>renderOffline(processor,{sampleRate,duration:(end-start)/sampleRate,inputs:{main:[input.slice(start,end),reset.slice(start,end)]},params:{gain:Array.from(gain.slice(start,end)),mix:Array.from(mix.slice(start,end))},restore});
  const whole=await offline(0,n),first=await offline(0,4096),next=await offline(4096,n,first.state);
  assert.deepEqual(actual,whole.outputs.main[0]);assert.deepEqual(next.outputs.main[0],actual.slice(4096));
  assert.equal(driver.scrubbedSamples(),0);assert.equal(whole.diagnostics.scrubbedSamples,0);assert.equal(next.diagnostics.scrubbedSamples,0);
  assert.equal(driver.memory.buffer.byteLength,memoryBytes);assert(actual.every(Number.isFinite));assert(actual.slice(8000).every(x=>x===0));
  const expected=oversampledReference(channels,factor,curve);let maximumOracleError=0;
  for(let i=0;i<n;i++)maximumOracleError=Math.max(maximumOracleError,Math.abs(actual[i]-expected[i]));
  assert(maximumOracleError<2e-6,`literal convolution mismatch ${maximumOracleError}`);
  const candidate=`candidate-oversampled-${factor}x-${curve}-${sampleRate}.wav`;writeFileSync(candidate,encodeWav([actual],sampleRate));
  const coldQuantumMs=times[0];times.sort((a,b)=>a-b);
  reports.push({sampleRate,factor,curve,frames:n,candidate,maximumOracleError,bulkLatencySamples:32,captureMs,compileMs,graphBytes:JSON.stringify(compiled.graph).length,wasmBytes:compiled.wasm.byteLength,memoryBytes,stateBytes:first.state.byteLength,
    coldQuantumMs,processP50Ms:times[Math.floor(times.length/2)],processMaxMs:times.at(-1),scrubbedSamples:0,resetSamples:[0,127,128,2049,6144,6145],snapshotSplit:4096,
    parameterEdits:'Native a-rate gain/mix writes, including intra-quantum edits',limitation:'Local single-instance Node process diagnostic, excludes copies and browser scheduling. No realtime deadline/capacity claim.'});
}
writeFileSync('oversampled-drive-results.json',JSON.stringify({status:'CANDIDATE',reports},null,2));console.log(JSON.stringify({reports}));
