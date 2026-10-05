// Capture-only scaling diagnostic; never compiles or renders audio.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {audioOutput,bool,defineProcessor,f32,forSample,instantiate} from '@unworklet/core';
const source=new URL(process.argv[2]??'../../src/sample.ts',import.meta.url);
const {granularSource,residentSample}=await import(source.href);
for(const maxGrains of [8,16,32]){
 const begin=performance.now(),p=defineProcessor(()=>{
  const sample=instantiate(residentSample,{capacity:128,sourceSampleRate:48000},{name:'asset'});
  const grains=instantiate(granularSource,{sampleRate:48000,sample,maxGrains,seed:71},{name:'grains'}),out=audioOutput({channels:2,name:'main'});
  return{process(){forSample(i=>{const s=grains.tick({gate:bool(true),reset:bool(false),positionFrames:f32(15),jitterFrames:f32(16),rate:f32(-.75),durationSeconds:f32(.01),densityHz:f32(2000)});out.ch(0).at(i).write(s.output);out.ch(1).at(i).write(f32(s.dropped));});}};
 });
 const cache=new WeakMap();let objects=0,edges=0;
 function size(v){if(v===undefined)return 0n;if(v===null||typeof v!=='object')return BigInt(JSON.stringify(v)?.length??0);if(cache.has(v))return cache.get(v);objects++;let bytes=2n;const entries=Array.isArray(v)?v.map((x,i)=>[i,x]):Object.entries(v).filter(([,x])=>x!==undefined);for(const[k,x]of entries){edges++;bytes+=size(x)+(Array.isArray(v)?0n:BigInt(JSON.stringify(k).length+1));}bytes+=BigInt(Math.max(0,entries.length-1));cache.set(v,bytes);return bytes;}
 const bytes=size(p.graph);console.log(JSON.stringify({maxGrains,captureMs:performance.now()-begin,uniqueObjects:objects,edges,expandedJsonBytes:String(bytes),sourceSHA256:createHash('sha256').update(readFileSync(source)).digest('hex')}));
}
