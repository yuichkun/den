import { audioOutput, bool, CAPACITY_16, defineProcessor, event, f32, f64, i32, forSample, instantiate, select, state } from '@unworklet/core';
import { granularSource, multisamplePlayer, residentSample, samplePlayer, type SampleZone, type ResidentSample } from '@denaudio/den/sample';
export const pcm = Float32Array.from({length:1024},(_,n)=>.6*Math.sin(2*Math.PI*n/64)+.3*n/1023);
export const sourceRate=32000,grainSeed=174;
export const makeProcessor=({zoneCount=16,grainCount=32}:{zoneCount?:number;grainCount?:number}={})=>defineProcessor(ctx=>{
 const sample:ResidentSample=instantiate(residentSample,{capacity:1024,sourceSampleRate:sourceRate},{name:'sample'});
 const load=event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:4096});load.onReceive(({data})=>sample.load(data));
 const loop=instantiate(samplePlayer,{sampleRate:ctx.sampleRate,sample,startFrame:3,endFrame:997,loop:true,releaseFrames:32},{name:'loop'});
 const reverse=instantiate(samplePlayer,{sampleRate:ctx.sampleRate,sample,startFrame:3,endFrame:997,loop:false},{name:'reverse'});
 const zones:SampleZone[]=Array.from({length:zoneCount},(_,n)=>({sample,keyLow:zoneCount===1?0:n*8,keyHigh:zoneCount===1?127:n*8+7,velocityLow:0,velocityHigh:1,rootKey:60,loop:true}));
 const bank=instantiate(multisamplePlayer,{sampleRate:ctx.sampleRate,zones},{name:'bank'});
 const grains=instantiate(granularSource,{sampleRate:ctx.sampleRate,sample,maxGrains:grainCount,seed:grainSeed},{name:'grains'});
 const frame=state.i32(0).named('frame'),out=audioOutput({channels:7,name:'main'});
 return {process(){forSample(i=>{
  const n=frame.read(),reset=bool(false),trigger=bool(false),ready=sample.length().gt(0),gate=n.lt(1536).and(ready);
  out.ch(0).at(i).write(loop.tick({gate,reset,trigger,rate:f32(.75)}).output);
  out.ch(1).at(i).write(reverse.tick({gate:ready,reset,trigger,rate:f32(-1.25)}).output);
  out.ch(2).at(i).write(bank.tick({gate:n.lt(2048).and(ready),reset,trigger,key:f32(72),velocity:f32(.75),rate:f32(1)}).output);
  const g=grains.tick({gate:n.lt(2048).and(ready),reset,positionFrames:f32(500),jitterFrames:f32(250),rate:f32(-.75),durationSeconds:f32(.05),densityHz:f32(2000)});
  out.ch(3).at(i).write(g.output);out.ch(4).at(i).write(f32(g.activeGrains));out.ch(5).at(i).write(f32(g.onset));out.ch(6).at(i).write(f32(g.dropped));
  frame.write(select(ready,n.add(1),n));
 });}};
});


/** Small browser/profiling entries share the exact same native PCM ingress. */
export const makeProfileProcessor=(kind:'resident'|'player'|'zones'|'grains',count=1)=>defineProcessor(ctx=>{
 const sample=instantiate(residentSample,{capacity:1024,sourceSampleRate:sourceRate},{name:'sample'});
 const load=event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:4096});load.onReceive(({data})=>sample.load(data));
 const player=kind==='player'?instantiate(samplePlayer,{sampleRate:ctx.sampleRate,sample,loop:true},{name:'player'}):null;
 const zones=kind==='zones'?instantiate(multisamplePlayer,{sampleRate:ctx.sampleRate,zones:Array.from({length:count},()=>({sample,keyLow:0,keyHigh:127,velocityLow:0,velocityHigh:1,rootKey:60,loop:true}))},{name:'zones'}):null;
 const grains=kind==='grains'?instantiate(granularSource,{sampleRate:ctx.sampleRate,sample,maxGrains:count,seed:grainSeed},{name:'grains'}):null;
 const frame=state.i32(0).named('frame'),out=audioOutput({channels:1,name:'main'});
 return{process(){forSample(i=>{
  const n=frame.read(),base={gate:bool(true),trigger:bool(false),reset:bool(false),rate:f32(.75)};
  const output=player?player.tick(base).output:zones?zones.tick({...base,key:f32(60.25),velocity:f32(.75)}).output:grains?grains.tick({...base,positionFrames:f32(500),jitterFrames:f32(250),durationSeconds:f32(.05),densityHz:f32(2000)}).output:sample.read(f64(n.mod(1024)),i32(0),i32(1024),true);
  out.ch(0).at(i).write(output);frame.write(n.add(1));
 });}};
});
