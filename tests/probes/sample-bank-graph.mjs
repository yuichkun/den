// Capture-only graph-size diagnostic; never compiles or renders audio.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {audioInput,audioOutput,CAPACITY_16,defineProcessor,event,f32,forSample,instantiate} from '@unworklet/core';
import {multisamplePlayer,residentSample} from '../../src/sample.ts';
const begin=performance.now();
const p=defineProcessor(()=>{
 const sample=instantiate(residentSample,{capacity:128,sourceSampleRate:48000},{name:'asset'});
 const load=event({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:512});load.onReceive(({data})=>sample.load(data));
 const player=instantiate(multisamplePlayer,{sampleRate:48000,zones:[0,1,2].map(n=>({sample,keyLow:n*40,keyHigh:n*40+39,velocityLow:0,velocityHigh:1,rootKey:60,loop:true}))},{name:'player'});
 const input=audioInput({channels:5,name:'controls'}),out=audioOutput({channels:3,name:'main'});
 return{process(){forSample(i=>{const s=player.tick({key:input.ch(0).at(i),velocity:input.ch(1).at(i),gate:input.ch(2).at(i).gt(0),trigger:input.ch(3).at(i).gt(0),reset:input.ch(4).at(i).gt(0),rate:f32(1)});out.ch(0).at(i).write(s.output);out.ch(1).at(i).write(f32(s.zoneIndex));out.ch(2).at(i).write(f32(s.missing));});}};
});
const cache=new WeakMap();let objects=0,edges=0;const kinds={};
function size(value){if(value===undefined)return 0n;if(value===null||typeof value!=='object')return BigInt(JSON.stringify(value)?.length??0);if(cache.has(value))return cache.get(value);objects++;if(value.kind)kinds[value.kind]=(kinds[value.kind]??0)+1;let bytes=2n;const entries=Array.isArray(value)?value.map((v,i)=>[i,v]):Object.entries(value).filter(([,v])=>v!==undefined);for(const [key,v]of entries){edges++;bytes+=size(v)+(Array.isArray(value)?0n:BigInt(JSON.stringify(key).length+1));}bytes+=BigInt(Math.max(0,entries.length-1));cache.set(value,bytes);return bytes;}
const bytes=size(p.graph);console.log(JSON.stringify({captureMs:performance.now()-begin,uniqueObjects:objects,edges,expandedJsonBytes:String(bytes),kinds,sourceSHA256:createHash('sha256').update(readFileSync(new URL('../../src/sample.ts',import.meta.url))).digest('hex')}));
