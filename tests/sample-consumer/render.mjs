import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {compile,inspect} from '@unworklet/core';
import {renderOffline,encodeWav} from '@unworklet/offline';
import {makeProcessor,makeProfileProcessor,pcm,sourceRate,grainSeed} from './processor.ts';
import {grainReference,playerReference} from './sample-reference.ts';
const frames=4096,reports=[];
for(const rate of [44100,48000,96000]){
 const processor=makeProcessor(),result=await renderOffline(processor,{sampleRate:rate,duration:(frames-.25)/rate,messages:[{name:'load',payload:{data:pcm}}]});
 const rows=Array.from({length:frames},(_,n)=>({gate:n<1536,reset:false,trigger:false,rate:.75}));
 const loop=playerReference(pcm,rate,sourceRate,rows,{loop:true,start:3,end:997,release:32}).output;
 const reverse=playerReference(pcm,rate,sourceRate,rows.map(x=>({...x,gate:true,rate:-1.25})),{start:3,end:997}).output;
 const bank=playerReference(pcm,rate,sourceRate,rows.map((x,n)=>({...x,gate:n<2048,rate:2})),{loop:true}).output.map(x=>Math.fround(x*.75));
 const grains=grainReference(pcm,rate,sourceRate,32,grainSeed,Array.from({length:frames},(_,n)=>({gate:n<2048,reset:false,position:500,jitter:250,rate:-.75,duration:Math.fround(.05),density:2000})));
 const errors=[loop,reverse,bank,grains.output,grains.counts,grains.onsets,grains.dropped].map((expected,ch)=>{
  let maximum=0;assert.equal(result.outputs.main[ch].length,frames);result.outputs.main[ch].forEach((v,n)=>{assert(Number.isFinite(v));maximum=Math.max(maximum,Math.abs(v-expected[n]));});assert(maximum<3e-6,`rate=${rate} ch=${ch} error=${maximum}`);return maximum;
 });
 assert.equal(Math.max(...result.outputs.main[4]),32);assert(result.outputs.main[6].some(x=>x===1));assert.equal(result.diagnostics.scrubbedSamples,0);
 if(rate===48000){
  const delayed=await renderOffline(processor,{sampleRate:rate,duration:(frames+256-.25)/rate,messages:[{name:'load',payload:{data:pcm},atQuantum:2}]});
  result.outputs.main.forEach((ch,n)=>{assert.deepEqual(delayed.outputs.main[n].slice(0,256),new Float32Array(256));assert.deepEqual(delayed.outputs.main[n].slice(256),ch);});
 }
 const first=await renderOffline(processor,{sampleRate:rate,duration:(1024-.25)/rate,messages:[{name:'load',payload:{data:pcm}}]});
 const rest=await renderOffline(processor,{sampleRate:rate,duration:(1024-.25)/rate,restore:first.state});result.outputs.main.forEach((ch,n)=>assert.deepEqual(rest.outputs.main[n],ch.slice(1024,2048)));
 writeFileSync(`candidate-samples-${rate}.wav`,encodeWav(result.outputs.main.slice(0,2),rate));writeFileSync(`candidate-granular-${rate}.wav`,encodeWav([result.outputs.main[3]],rate));
 reports.push({rate,frames,errors,scrubbedSamples:result.diagnostics.scrubbedSamples,stateBytes:result.state.byteLength,snapshotSlots:Object.keys(inspect(result.state).slots).length});
}
const compiled=await compile(makeProcessor(),{sampleRate:48000}),driver=await compiled.driver.instantiate();
// The public compile driver has no message-injection/restore API. This
// allocation/timing diagnostic starts unloaded; the offline renders above prove
// the loaded maximum active pool. Never write private ring memory to prime it.
const memoryBytes=driver.memory.buffer.byteLength;for(let n=0;n<32;n++)driver.process();const timings=[];for(let n=0;n<32;n++){const start=performance.now();driver.process();timings.push(performance.now()-start);}
assert.equal(driver.memory.buffer.byteLength,memoryBytes);assert.equal(driver.scrubbedSamples(),0);timings.sort((a,b)=>a-b);
const diagnostic={graph:'one shared 1024-frame resident; 16 zones; 32-grain pool; loop and reverse players',residentLoaded:false,sampleRate:48000,blocks:32,warmupBlocks:32,memoryBytes,wasmBytes:compiled.wasm.byteLength,wasmSHA256:createHash('sha256').update(compiled.wasm).digest('hex'),p50Ms:timings[16],maximumMs:timings.at(-1),limitation:'Unloaded Node driver timing only; no active-pool performance, browser scheduling, audio device, host transport or realtime deadline claim'};
writeFileSync('sample-results.json',JSON.stringify({status:'CANDIDATE',reports,diagnostic},null,2));console.log(JSON.stringify({reports,diagnostic}));
