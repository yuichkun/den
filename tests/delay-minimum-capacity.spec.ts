import {expect,test} from 'vitest';
import {createHash} from 'node:crypto';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
import {audioInput,audioOutput,bool,compile,defineProcessor,f32,forSample,instantiate} from '@unworklet/core';
import {renderOffline} from '@unworklet/offline';
import {delayReadhead} from '../src/delay-readhead.js';
import {delayReadhead as before} from './fixtures/delay-readhead-before-minimum.js';
import {flanger} from '../src/modulation-fx.js';
import {pingPongDelay,multiTapDelay} from '../src/stereo-delay.js';
function nextDown(x:number){const b=new ArrayBuffer(8),v=new DataView(b);v.setFloat64(0,x);v.setBigUint64(0,v.getBigUint64(0)-1n);return v.getFloat64(0);}
function probe(rate:number,capacity:number,kind:'primitive'|'flanger'|'ping'|'multi'){
 return defineProcessor(()=>{
  const input=audioInput({name:'main',channels:1}),out=audioOutput({name:'main',channels:1}),config={sampleRate:rate,maxDelaySeconds:capacity};
  const controls={feedback:f32(0),mix:f32(1),bypass:bool(false),reset:bool(false)};
  if(kind==='primitive'){const d=instantiate(delayReadhead,config,{name:'d'});return{process(){forSample(i=>out.ch(0).at(i).write(d.tick(input.ch(0).at(i),f32(1/rate),bool(false)).output));}};}
  if(kind==='flanger'){const d=instantiate(flanger,config,{name:'d'});return{process(){forSample(i=>out.ch(0).at(i).write(d.tick(input.ch(0).at(i),f32(0),{...controls,delaySeconds:f32(1/rate),depthSeconds:f32(0),rateHz:f32(0)}).left));}};}
  if(kind==='ping'){const d=instantiate(pingPongDelay,config,{name:'d'});return{process(){forSample(i=>out.ch(0).at(i).write(d.tick(input.ch(0).at(i),f32(0),{...controls,timeSeconds:f32(1/rate)}).left));}};}
  const d=instantiate(multiTapDelay,{...config,taps:[{delaySeconds:capacity,gainLeft:1,gainRight:0}]},{name:'d'});return{process(){forSample(i=>out.ch(0).at(i).write(d.tick(input.ch(0).at(i),controls).left));}};
 });
}
for(const rate of [8001,8013,11025,44100,48000,96000,192000])test(`exact one-sample capacity works and nextDown rejects at ${rate}`,async()=>{
 const minimum=1/rate,input=Float32Array.from({length:128},(_,i)=>i===0?1:0);
 for(const kind of ['primitive','flanger','ping','multi'] as const){
  expect(()=>probe(rate,nextDown(minimum),kind)).toThrow();
  const result=await renderOffline(probe(rate,minimum,kind),{sampleRate:rate,duration:(128-.5)/rate,inputs:{main:[input]}});
  expect(result.diagnostics.scrubbedSamples).toBe(0);expect(Array.from(result.outputs.main[0])).toEqual(Array.from({length:128},(_,i)=>i===1?1:0));
 }
},60000);
function parity(rate:number,capacity:number,old:boolean){return defineProcessor(()=>{
 const input=audioInput({name:'main',channels:3}),out=audioOutput({name:'main',channels:2});
 const d=instantiate(old?before:delayReadhead,{sampleRate:rate,maxDelaySeconds:capacity},{name:'d'});
 return{process(){forSample(i=>{const x=d.tick(input.ch(0).at(i),input.ch(1).at(i),input.ch(2).at(i).gt(0));out.ch(0).at(i).write(x.output);out.ch(1).at(i).write(f32(x.outOfRange));});}};
},{id:'den.delay.minimum.parity'});}
for(const rate of [44100,48000,96000])test(`valid common-rate PCM, full state and WASM are unchanged at ${rate}`,async()=>{
 for(const capacity of [1/rate,32/rate,1,2]){
  const a=parity(rate,capacity,true),b=parity(rate,capacity,false),n=512;
  const reset=new Float32Array(n);reset[257]=1;
  const options={sampleRate:rate,duration:(n-.5)/rate,inputs:{main:[Float32Array.from({length:n},(_,i)=>.3*Math.sin(i*.13)),new Float32Array(n).fill(Math.min(capacity,13.25/rate)),reset]}};
  const old=await renderOffline(a,options),fixed=await renderOffline(b,options);
  expect(old.diagnostics.scrubbedSamples).toBe(0);expect(fixed.diagnostics.scrubbedSamples).toBe(0);expect(fixed.outputs).toEqual(old.outputs);expect(hash(fixed.state)).toBe(hash(old.state));
  expect(hash((await compile(b,{sampleRate:rate})).wasm)).toBe(hash((await compile(a,{sampleRate:rate})).wasm));
 }
},120000);
