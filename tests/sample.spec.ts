import {expect,test} from 'vitest';
import {audioInput,audioOutput,bool,CAPACITY_16,compile,decodeSnapshot,defineProcessor,encodeScalar,encodeSnapshot,event,f32,f64,i32,forSample,instantiate,type Node} from '@unworklet/core';
import {renderOffline} from '@unworklet/offline';
import {granularSource,multisamplePlayer,residentSample,samplePlayer,type SamplePlayerConfig} from '../src/sample.js';
import {f,grainReference,playerReference,type GrainRow,type PlayerRow} from './fixtures/sample-reference.js';
const rates=[44100,48000,96000],frames=512;
const duration=(n:number,rate:number)=>(n-.25)/rate;
function close(actual:Float32Array,expected:ArrayLike<number>,tol=3e-6){expect(actual.length).toBe(expected.length);let error=0;actual.forEach((x,i)=>{expect(Number.isFinite(x)).toBe(true);error=Math.max(error,Math.abs(x-expected[i]));});expect(error).toBeLessThan(tol);}
const pcm=Float32Array.from({length:97},(_,n)=>.6*Math.sin(2*Math.PI*n/32)+.4*(n/96));
function playerProcessor(rate:number,sourceRate:number,options:Partial<SamplePlayerConfig>={},capacity=pcm.length){
 return defineProcessor(()=>{
  const asset=instantiate(residentSample,{capacity,sourceSampleRate:sourceRate},{name:'asset'});
  const load=event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:capacity*4});load.onReceive(x=>asset.load(x.data));
  const player=instantiate(samplePlayer,{sampleRate:rate,sample:asset,...options},{name:'player'});
  const input=audioInput({channels:4,name:'controls'}),output=audioOutput({channels:4,name:'main'});
  return {process(){forSample(i=>{const s=player.tick({gate:input.ch(0).at(i).gt(0),trigger:input.ch(1).at(i).gt(0),reset:input.ch(2).at(i).gt(0),rate:input.ch(3).at(i)});output.ch(0).at(i).write(s.output);output.ch(1).at(i).write(f32(s.active));output.ch(2).at(i).write(s.position);output.ch(3).at(i).write(f32(s.missing));});}};
 });
}
const playerInput=(rows:PlayerRow[])=>[Float32Array.from(rows,x=>+x.gate),Float32Array.from(rows,x=>+x.trigger),Float32Array.from(rows,x=>+x.reset),Float32Array.from(rows,x=>x.rate)];
for(const rate of rates){
 test(`sample impulse/ramp/sine PCM public ingress, slice, reverse, fractional rates and loop edges ${rate}`,async()=>{
  for(const [kind,data] of [['impulse',Float32Array.from({length:97},(_,n)=>+(n===3))],['ramp',Float32Array.from({length:97},(_,n)=>n/97)],['sine',pcm]] as const){
   for(const loop of [false,true]){
    const rows=Array.from({length:frames},(_,n)=>({gate:n<350||n>=400,trigger:n===130||n===280,reset:n>=255&&n<260,rate:f(n<130?.5:n<280?-1.25:n<410?0:17)}));
    const p=playerProcessor(rate,32000,{loop,startFrame:3,endFrame:91,releaseFrames:9});
    const result=await renderOffline(p,{sampleRate:rate,duration:duration(frames,rate),inputs:{controls:playerInput(rows)},messages:[{name:'load',payload:{data}}]});
    const expected=playerReference(data,rate,32000,rows,{start:3,end:91,loop,release:9});
    close(result.outputs.main[0],expected.output);close(result.outputs.main[1],expected.playing.map(Number));
    expect(result.diagnostics.scrubbedSamples).toBe(0);expect(kind).toBeTruthy();
   }
  }
 });
 test(`sample snapshot exact continuation, gate release and held reset ${rate}`,async()=>{
  const rows=Array.from({length:frames},(_,n)=>({gate:n<256,trigger:false,reset:n>=400&&n<410,rate:f(-.7)}));
  const p=playerProcessor(rate,48000,{loop:true,releaseFrames:16});
  const run=(r:PlayerRow[],restore?:Uint8Array)=>renderOffline(p,{sampleRate:rate,duration:duration(r.length,rate),inputs:{controls:playerInput(r)},...(restore?{restore}:{messages:[{name:'load',payload:{data:pcm}}]})});
  const full=await run(rows),first=await run(rows.slice(0,256)),rest=await run(rows.slice(256),first.state);
  expect(rest.outputs.main).toEqual(full.outputs.main.map(x=>x.slice(256)));close(full.outputs.main[0],playerReference(pcm,rate,48000,rows,{loop:true,release:16}).output);
  expect([...full.outputs.main[0].slice(272)]).toEqual(Array(240).fill(0));
 });
 test(`sample missing/replacement/empty/shorter asset and single-frame boundary ${rate}`,async()=>{
  const rows=Array.from({length:512},(_,n)=>({gate:true,trigger:n===257,reset:false,rate:1}));
  const p=playerProcessor(rate,rate,{loop:true},8),input=playerInput(rows);
  const r=await renderOffline(p,{sampleRate:rate,duration:duration(512,rate),inputs:{controls:input},messages:[{name:'load',payload:{data:Float32Array.from([1,2,3,4,5,6,7,8])},atQuantum:1},{name:'load',payload:{data:Float32Array.of(.25)},atQuantum:2},{name:'load',payload:{data:new Float32Array()},atQuantum:3}]});
  expect(r.outputs.main[0].slice(0,257)).toEqual(new Float32Array(257));expect(r.outputs.main[0].slice(257,384)).toEqual(new Float32Array(127).fill(.25));expect(r.outputs.main[0].slice(384)).toEqual(new Float32Array(128));
  expect(r.outputs.main[3][0]).toBe(1);expect(r.outputs.main[3][128]).toBe(0);expect(r.outputs.main[3][384]).toBe(1);expect(r.diagnostics.scrubbedSamples).toBe(0);
 });
 test(`sample nonfinite PCM/control safety and zero/large signed rate ${rate}`,async()=>{
  const data=Float32Array.of(1,NaN,Infinity,-Infinity,.5),rows=Array.from({length:256},(_,n)=>({gate:true,trigger:n%16===0,reset:false,rate:[0,NaN,Infinity,-Infinity,.5,-.5][n%6]}));
  const r=await renderOffline(playerProcessor(rate,rate,{loop:true},data.length),{sampleRate:rate,duration:duration(256,rate),inputs:{controls:playerInput(rows)},messages:[{name:'load',payload:{data}}]});
  close(r.outputs.main[0],playerReference(data,rate,rate,rows,{loop:true}).output);expect(r.diagnostics.scrubbedSamples).toBe(0);
 });
 test(`multisample first-match zones, boundaries, root pitch, latch, missing asset and reset ${rate}`,async()=>{
  const p=defineProcessor(()=>{
   const a=instantiate(residentSample,{capacity:128,sourceSampleRate:rate},{name:'a'}),b=instantiate(residentSample,{capacity:128,sourceSampleRate:rate},{name:'b'});
   const ea=event<{data:Float32Array}>({from:'main',name:'a',capacity:CAPACITY_16,payloadCapacity:512}),eb=event<{data:Float32Array}>({from:'main',name:'b',capacity:CAPACITY_16,payloadCapacity:512});ea.onReceive(x=>a.load(x.data));eb.onReceive(x=>b.load(x.data));
   const player=instantiate(multisamplePlayer,{sampleRate:rate,zones:[{sample:a,keyLow:48,keyHigh:60,velocityLow:0,velocityHigh:.5,rootKey:48,loop:true},{sample:b,keyLow:60,keyHigh:72,velocityLow:0,velocityHigh:1,rootKey:60,loop:true},{sample:a,keyLow:73,keyHigh:127,velocityLow:0,velocityHigh:1,rootKey:73,loop:true}]},{name:'zones'});
   const input=audioInput({channels:5,name:'controls'}),out=audioOutput({channels:3,name:'main'});
   return {process(){forSample(i=>{const s=player.tick({key:input.ch(0).at(i),velocity:input.ch(1).at(i),gate:input.ch(2).at(i).gt(0),trigger:input.ch(3).at(i).gt(0),reset:input.ch(4).at(i).gt(0),rate:f32(1)});out.ch(0).at(i).write(s.output);out.ch(1).at(i).write(f32(s.zoneIndex));out.ch(2).at(i).write(f32(s.missing));});}};
  });
  const data=Float32Array.from({length:128},(_,n)=>n/128);
  const controls=[Float32Array.from({length:512},(_,n)=>n<128?60:n<256?72:n<384?40:73),Float32Array.from({length:512},(_,n)=>n<64?.5:1),new Float32Array(512).fill(1),Float32Array.from({length:512},(_,n)=>+(n%128===0)),new Float32Array(512)];
  const result=await renderOffline(p,{sampleRate:rate,duration:duration(512,rate),inputs:{controls},messages:[{name:'a',payload:{data}}]});
  close(result.outputs.main[0].slice(0,128),Float32Array.from({length:128},(_,n)=>(n*2%128)/256));
  expect(result.outputs.main[1][0]).toBe(0);expect(result.outputs.main[1][127]).toBe(0);expect(result.outputs.main[1][128]).toBe(1);expect(result.outputs.main[2][128]).toBe(1);expect(result.outputs.main[1][256]).toBe(-1);expect(result.outputs.main[2][256]).toBe(1);expect(result.outputs.main[1][384]).toBe(2);expect(result.outputs.main[0][385]).toBe(1/128);
  const first=await renderOffline(p,{sampleRate:rate,duration:duration(128,rate),inputs:{controls:controls.map(x=>x.slice(0,128))},messages:[{name:'a',payload:{data}}]});
  const rest=await renderOffline(p,{sampleRate:rate,duration:duration(384,rate),inputs:{controls:controls.map(x=>x.slice(128))},restore:first.state});expect(rest.outputs.main).toEqual(result.outputs.main.map(x=>x.slice(128)));
 });
 test(`granular independent fixed-seed PCM/triangular window, onset, saturation/drop, reset/release and snapshot ${rate}`,async()=>{
  const p=defineProcessor(()=>{
   const sample=instantiate(residentSample,{capacity:pcm.length,sourceSampleRate:32000},{name:'asset'});const load=event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:pcm.length*4});load.onReceive(x=>sample.load(x.data));
   const grains=instantiate(granularSource,{sampleRate:rate,sample,maxGrains:3,seed:1234},{name:'grains'}),input=audioInput({channels:7,name:'controls'}),out=audioOutput({channels:4,name:'main'});
   return {process(){forSample(i=>{const s=grains.tick({gate:input.ch(0).at(i).gt(0),reset:input.ch(1).at(i).gt(0),positionFrames:input.ch(2).at(i),jitterFrames:input.ch(3).at(i),rate:input.ch(4).at(i),durationSeconds:input.ch(5).at(i),densityHz:input.ch(6).at(i)});[s.output,f32(s.activeGrains),f32(s.onset),f32(s.dropped)].forEach((v,ch)=>out.ch(ch).at(i).write(v));});}};
  });
  const rows:GrainRow[]=Array.from({length:1024},(_,n)=>({gate:n<400||n>=600,reset:n>=510&&n<514,position:f(n%97),jitter:30,rate:f(n<256?.7:-1.4),duration:f(200/rate),density:2000}));
  const inputs=(r:GrainRow[])=>[Float32Array.from(r,x=>+x.gate),Float32Array.from(r,x=>+x.reset),...(['position','jitter','rate','duration','density'] as const).map(k=>Float32Array.from(r,x=>x[k]))];
  const full=await renderOffline(p,{sampleRate:rate,duration:duration(1024,rate),inputs:{controls:inputs(rows)},messages:[{name:'load',payload:{data:pcm}}]});
  const expected=grainReference(pcm,rate,32000,3,1234,rows);[expected.output,expected.counts,expected.onsets,expected.dropped].forEach((x,i)=>close(full.outputs.main[i],x));expect(expected.dropped.some(Boolean)).toBe(true);expect(Math.max(...full.outputs.main[1])).toBe(3);expect(full.diagnostics.scrubbedSamples).toBe(0);
  const first=await renderOffline(p,{sampleRate:rate,duration:duration(512,rate),inputs:{controls:inputs(rows.slice(0,512))},messages:[{name:'load',payload:{data:pcm}}]});const rest=await renderOffline(p,{sampleRate:rate,duration:duration(512,rate),inputs:{controls:inputs(rows.slice(512))},restore:first.state});expect(rest.outputs.main).toEqual(full.outputs.main.map(x=>x.slice(512)));
 });
}
test('sample/granular construction constraints reject invalid metadata and pool/zone sizes',()=>{
 for(const capacity of [0,-1,1.5,65537,Infinity])expect(()=>defineProcessor(()=>{instantiate(residentSample,{capacity,sourceSampleRate:48000});return{process(){}};})).toThrow(RangeError);
 for(const sourceSampleRate of [NaN,7999,192001])expect(()=>defineProcessor(()=>{instantiate(residentSample,{capacity:8,sourceSampleRate});return{process(){}};})).toThrow(RangeError);
 for(const count of [0,33])expect(()=>defineProcessor(()=>{const sample=instantiate(residentSample,{capacity:8,sourceSampleRate:48000},{name:'sample'});instantiate(granularSource,{sampleRate:48000,sample,maxGrains:count});return{process(){}};})).toThrow(RangeError);
 for(const zones of [[],Array(17).fill({})])expect(()=>defineProcessor(()=>{instantiate(multisamplePlayer,{sampleRate:48000,zones});return{process(){}};})).toThrow(RangeError);
});

test('public resident ingress: over-capacity truncation, empty/short replacement, stale direct reads',async()=>{
 const processor=defineProcessor(()=>{
  const sample=instantiate(residentSample,{capacity:8,sourceSampleRate:48000},{name:'sample'});
  const load=event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:64});load.onReceive(x=>sample.load(x.data));
  const output=audioOutput({channels:3,name:'main'});
  return {process(){forSample(i=>{output.ch(0).at(i).write(sample.read(f64(i.mod(8)),i32(0),i32(8),false));output.ch(1).at(i).write(f32(sample.length()));output.ch(2).at(i).write(f32(sample.revision()));});}};
 });
 const full=await renderOffline(processor,{sampleRate:48000,duration:duration(512,48000),messages:[
  {name:'load',payload:{data:Float32Array.from({length:16},(_,i)=>i+1)}},
  {name:'load',payload:{data:Float32Array.of(.5,.25)},atQuantum:1},
  {name:'load',payload:{data:new Float32Array()},atQuantum:2},
 ]});
 expect([...full.outputs.main[0].slice(0,8)]).toEqual([1,2,3,4,5,6,7,8]);expect(full.outputs.main[1][0]).toBe(8);
 // Public reads above loaded length clamp to the final loaded frame; never stale data.
 expect([...full.outputs.main[0].slice(128,136)]).toEqual([.5,.25,.25,.25,.25,.25,.25,.25]);
 expect(full.outputs.main[0].slice(256)).toEqual(new Float32Array(256));expect([full.outputs.main[2][0],full.outputs.main[2][128],full.outputs.main[2][256]]).toEqual([1,2,3]);
 expect(full.diagnostics.scrubbedSamples).toBe(0);
});

test('maximum 65,536-frame resident and explicit 16-slot ingress retain last PCM and exact snapshot without memory growth',async()=>{
 const capacity=65536,processor=defineProcessor(()=>{
  const sample=instantiate(residentSample,{capacity,sourceSampleRate:192000},{name:'asset'});
  const load=event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:capacity*4});load.onReceive(x=>sample.load(x.data));
  const output=audioOutput({channels:3,name:'main'});
  return{process(){forSample(i=>{output.ch(0).at(i).write(sample.read(f64(65535),i32(0),i32(capacity),false));output.ch(1).at(i).write(sample.read(f64(65535.5),i32(0),i32(capacity),true));output.ch(2).at(i).write(f32(sample.length()));});}};
 });
 const data=new Float32Array(capacity);data[0]=-.25;data[capacity-1]=.75;
 const first=await renderOffline(processor,{sampleRate:48000,duration:duration(128,48000),messages:Array.from({length:16},()=>({name:'load',payload:{data}}))});
 expect(decodeSnapshot(first.state).slots.find(x=>x.name==='asset/revision')?.data).toEqual(encodeScalar('i32',16));
 expect(first.outputs.main[0]).toEqual(new Float32Array(128).fill(.75));expect(first.outputs.main[1]).toEqual(new Float32Array(128).fill(.25));expect(first.outputs.main[2][0]).toBe(capacity);
 const restored=await renderOffline(processor,{sampleRate:48000,duration:duration(128,48000),restore:first.state});expect(restored.outputs.main).toEqual(first.outputs.main);
 const compiled=await compile(processor,{sampleRate:48000}),driver=await compiled.driver.instantiate();const bytes=driver.memory.buffer.byteLength;for(let n=0;n<16;n++)driver.process();expect(driver.memory.buffer.byteLength).toBe(bytes);expect(bytes).toBeGreaterThanOrEqual(capacity*4*17);expect(bytes).toBeLessThan(5*1024*1024);expect(driver.scrubbedSamples()).toBe(0);
});

for(const loop of [false,true])test(`granular reset replays seed; pool 32 maximum and endpoint-zero window (loop=${loop})`,async()=>{
 const data=Float32Array.from({length:17},(_,i)=>i/17),frames=1024,rate=48000;
 const p=defineProcessor(()=>{
  const sample=instantiate(residentSample,{capacity:data.length,sourceSampleRate:rate},{name:'asset'}),load=event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:data.byteLength});load.onReceive(x=>sample.load(x.data));
  const grain=instantiate(granularSource,{sampleRate:rate,sample,maxGrains:32,seed:71,loop},{name:'grain'}),input=audioInput({channels:1,name:'reset'}),out=audioOutput({channels:2,name:'main'});
  return{process(){forSample(i=>{const s=grain.tick({gate:bool(true),reset:input.ch(0).at(i).gt(0),positionFrames:f32(15),jitterFrames:f32(16),rate:f32(-.75),durationSeconds:f32(9/rate),densityHz:f32(2000)});out.ch(0).at(i).write(s.output);out.ch(1).at(i).write(f32(s.activeGrains));});}};
 });
 const reset=Float32Array.from({length:frames},(_,n)=>+(n===511));
 const full=await renderOffline(p,{sampleRate:rate,duration:duration(frames,rate),inputs:{reset:[reset]},messages:[{name:'load',payload:{data}}]});
 expect(full.outputs.main[0].slice(512,1023)).toEqual(full.outputs.main[0].slice(0,511));expect(full.outputs.main[0][0]).toBe(0);expect(full.outputs.main[0][8]).toBe(0);expect(full.outputs.main[1][9]).toBe(0);
 const rows:GrainRow[]=Array.from({length:frames},(_,n)=>({gate:true,reset:n===511,position:15,jitter:16,rate:-.75,duration:f(9/rate),density:2000}));
 close(full.outputs.main[0],grainReference(data,rate,rate,32,71,rows,loop).output);expect(full.diagnostics.scrubbedSamples).toBe(0);
});

test('linear sample interpolation is not antialiasing: doubled high sine folds below Nyquist',async()=>{
 const rate=48000,data=Float32Array.from({length:64},(_,n)=>Math.sin(2*Math.PI*20*n/64));
 const rows=Array.from({length:512},()=>({gate:true,trigger:false,reset:false,rate:2}));
 const result=await renderOffline(playerProcessor(rate,rate,{loop:true},64),{sampleRate:rate,duration:duration(512,rate),inputs:{controls:playerInput(rows)},messages:[{name:'load',payload:{data}}]});
 close(result.outputs.main[0],Float32Array.from({length:512},(_,n)=>-Math.sin(2*Math.PI*24*n/64)));
 let alias=0;result.outputs.main[0].forEach((x,n)=>alias+=2/512*x*Math.sin(2*Math.PI*24*n/64));expect(alias).toBeCloseTo(-1,6);
});


test('sample replacement invalidation survives signed and unsigned revision wrap',async()=>{
 const rate=48000,p=playerProcessor(rate,rate,{loop:true},8),data=Float32Array.of(.5,.25);
 const held=Array.from({length:128},()=>({gate:true,trigger:false,reset:false,rate:1}));
 const first=await renderOffline(p,{sampleRate:rate,duration:duration(128,rate),inputs:{controls:playerInput(held)},messages:[{name:'load',payload:{data}}]});
 for(const before of [2147483647,-1]){
  const snapshot=decodeSnapshot(first.state);
  const revisions=snapshot.slots.filter(slot=>slot.name==='asset/revision'||slot.name==='player/revision');expect(revisions.length).toBe(2);
  revisions.forEach(slot=>{slot.data=encodeScalar('i32',before);});
  const restored=encodeSnapshot(snapshot.schemaHash,snapshot.profile,snapshot.slots,snapshot.processorId);
  const rows=held.map((row,n)=>({...row,trigger:n===1}));
  const result=await renderOffline(p,{sampleRate:rate,duration:duration(128,rate),restore:restored,inputs:{controls:playerInput(rows)},messages:[{name:'load',payload:{data:Float32Array.of(.75)}}]});
  expect(result.outputs.main[0][0]).toBe(0);expect(result.outputs.main[0].slice(1)).toEqual(new Float32Array(127).fill(.75));
 }
});

test('sixteen distinct maximum residents: bounded 64 MiB ingress plus 4 MiB PCM bank and complete loads',async()=>{
 const capacity=65536;
 const processor=defineProcessor(()=>{
  const samples=Array.from({length:16},(_,n)=>{
   const sample=instantiate(residentSample,{capacity,sourceSampleRate:48000},{name:`asset${n}`});
   const load=event<{data:Float32Array}>({from:'main',name:`load${n}`,capacity:CAPACITY_16,payloadCapacity:capacity*4});load.onReceive(x=>sample.load(x.data));return sample;
  });
  const out=audioOutput({channels:16,name:'main'});
  return {process(){forSample(i=>samples.forEach((sample,ch)=>out.ch(ch).at(i).write(sample.read(f64(capacity-1),i32(0),i32(capacity),false))));}};
 });
 expect(processor.worklet.messageRings.reduce((bytes,ring)=>bytes+(ring.payloadContent?.capacity??0),0)).toBe(64*1024*1024);
 const result=await renderOffline(processor,{sampleRate:48000,duration:duration(128,48000),messages:Array.from({length:16},(_,n)=>{const data=new Float32Array(capacity);data[capacity-1]=(n+1)/16;return{name:`load${n}`,payload:{data}};})});
 result.outputs.main.forEach((ch,n)=>expect(ch).toEqual(new Float32Array(128).fill((n+1)/16)));expect(result.diagnostics.scrubbedSamples).toBe(0);
 const decoded=decodeSnapshot(result.state),buffers=decoded.slots.filter(x=>x.kind==='buffer');expect(buffers.length).toBe(16);expect(buffers.reduce((bytes,x)=>bytes+x.data.byteLength,0)).toBe(4*1024*1024);
});

for(const rate of rates)test(`multisample fractional key/cents use independent pitch ratio and correct source-rate conversion ${rate}`,async()=>{
 const data=Float32Array.from({length:64},(_,n)=>Math.sin(2*Math.PI*n/64));
 const p=defineProcessor(()=>{
  const sample=instantiate(residentSample,{capacity:64,sourceSampleRate:32000},{name:'asset'}),load=event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:256});load.onReceive(x=>sample.load(x.data));
  const player=instantiate(multisamplePlayer,{sampleRate:rate,zones:[{sample,keyLow:0,keyHigh:127,velocityLow:0,velocityHigh:1,rootKey:60,tuneCents:73,loop:true}]},{name:'player'}),input=audioInput({channels:2,name:'controls'}),out=audioOutput({channels:1,name:'main'});
  return{process(){forSample(i=>out.ch(0).at(i).write(player.tick({key:input.ch(0).at(i),velocity:f32(1),gate:bool(true),trigger:input.ch(1).at(i).gt(0),reset:bool(false),rate:f32(1)}).output));}};
 });
 const keys=Float32Array.from({length:512},(_,n)=>[33.2,60.25,71.9,96.8][Math.floor(n/128)]),trigger=Float32Array.from({length:512},(_,n)=>+(n%128===0));
 const result=await renderOffline(p,{sampleRate:rate,duration:duration(512,rate),inputs:{controls:[keys,trigger]},messages:[{name:'load',payload:{data}}]});
 const rows=Array.from({length:512},(_,n)=>({gate:true,trigger:trigger[n]>0,reset:false,rate:f(2**((keys[n]-60)/12+73/1200))}));
 close(result.outputs.main[0],playerReference(data,rate,32000,rows,{loop:true}).output);expect(result.diagnostics.scrubbedSamples).toBe(0);
});

test('direct resident read sanitizes nonfinite/out-of-range positions without exposing stale/adjacent PCM',async()=>{
 const p=defineProcessor(()=>{
  const sample=instantiate(residentSample,{capacity:8,sourceSampleRate:48000},{name:'asset'}),load=event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:32});load.onReceive(x=>sample.load(x.data));
  const input=audioInput({channels:1,name:'position'}),out=audioOutput({channels:2,name:'main'});
  return{process(){forSample(i=>{out.ch(0).at(i).write(sample.read(f64(input.ch(0).at(i)),i32(1),i32(4),false));out.ch(1).at(i).write(sample.read(f64(input.ch(0).at(i)),i32(1),i32(4),true));});}};
 });
 const values=[NaN,Infinity,-Infinity,-1e20,1e20,-.5,3.5,4,0,1,2,3],data=Float32Array.of(90,1,2,3,90,90,90,90);
 const positions=Float32Array.from({length:128},(_,n)=>values[n%values.length]),r=await renderOffline(p,{sampleRate:48000,duration:duration(128,48000),inputs:{position:[positions]},messages:[{name:'load',payload:{data}}]});
 for(let n=0;n<128;n++){
  const position=Math.max(-2147483648,Math.min(2147483647,Number.isNaN(positions[n])?1:positions[n]));
  const wrapped=1+((position-1)%3+3)%3;
  expect(r.outputs.main[0][n]).toBe(Math.max(1,Math.min(3,position)));
  expect(r.outputs.main[1][n]).toBeCloseTo(wrapped<=3?wrapped:3+(1-3)*(wrapped-3),6);
 }
 expect(r.diagnostics.scrubbedSamples).toBe(0);
});


test('native offline ingress budget truncates before resident load; host must reject oversize PCM itself',async()=>{
 const p=defineProcessor(()=>{
  const sample=instantiate(residentSample,{capacity:16,sourceSampleRate:48000},{name:'asset'}),load=event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:32});load.onReceive(x=>sample.load(x.data));
  const out=audioOutput({channels:2,name:'main'});return{process(){forSample(i=>{out.ch(0).at(i).write(sample.read(f64(15),i32(0),i32(16),false));out.ch(1).at(i).write(f32(sample.length()));});}};
 });
 const r=await renderOffline(p,{sampleRate:48000,duration:duration(128,48000),messages:[{name:'load',payload:{data:Float32Array.from({length:16},(_,n)=>n+1)}}]});
 expect(r.outputs.main[0]).toEqual(new Float32Array(128).fill(8));expect(r.outputs.main[1]).toEqual(new Float32Array(128).fill(8));expect(r.diagnostics.scrubbedSamples).toBe(0);
});

test('gate-off releases end on the exact integer frame for non-power-of-two lengths',async()=>{
 for(const releaseFrames of [1,3,9,127]){
  const rate=48000,rows=Array.from({length:256},(_,n)=>({gate:n<128,trigger:false,reset:false,rate:0}));
  const r=await renderOffline(playerProcessor(rate,rate,{loop:true,releaseFrames},1),{sampleRate:rate,duration:duration(256,rate),inputs:{controls:playerInput(rows)},messages:[{name:'load',payload:{data:Float32Array.of(1)}}]});
  close(r.outputs.main[0],Float32Array.from({length:256},(_,n)=>n<128?1:Math.max(0,(releaseFrames-(n-127))/releaseFrames)));
  expect(r.outputs.main[0][127+releaseFrames]).toBe(0);expect(r.outputs.main[1][127+releaseFrames]).toBe(0);
 }
});

test('full finite PCM preserves tiny interpolation position, player rate and latched velocity above native scalar flush floor',async()=>{
 const largest=f(3.4028234663852886e38),tiny=f(1e-35),data=Float32Array.of(0,largest),rate=48000;
 const p=defineProcessor(()=>{
  const sample=instantiate(residentSample,{capacity:2,sourceSampleRate:rate},{name:'asset'}),load=event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:8});load.onReceive(x=>sample.load(x.data));
  const player=instantiate(samplePlayer,{sampleRate:rate,sample,loop:true},{name:'player'});
  const zone=instantiate(multisamplePlayer,{sampleRate:rate,zones:[{sample,keyLow:0,keyHigh:127,velocityLow:0,velocityHigh:1,rootKey:60,loop:true,startFrame:1,endFrame:2}]},{name:'zone'});
  const out=audioOutput({channels:4,name:'main'});return{process(){forSample(i=>{
   out.ch(0).at(i).write(sample.read(f64(1e-70),i32(0),i32(2),false));
   out.ch(1).at(i).write(sample.read(f64(1e-35),i32(0),i32(2),true));
   out.ch(2).at(i).write(player.tick({gate:bool(true),trigger:bool(false),reset:bool(false),rate:f32(tiny)}).output);
   out.ch(3).at(i).write(zone.tick({key:f32(60),velocity:f32(tiny),gate:bool(true),trigger:bool(false),reset:bool(false),rate:f32(0)}).output);
  });}};
 });
 const r=await renderOffline(p,{sampleRate:rate,duration:duration(128,rate),messages:[{name:'load',payload:{data}}]});
 expect(r.outputs.main[0]).toEqual(new Float32Array(128).fill(f(largest*1e-70)));expect(r.outputs.main[1]).toEqual(new Float32Array(128).fill(f(largest*1e-35)));
 r.outputs.main[2].forEach((x,n)=>expect(x).toBeCloseTo(f(n*tiny*largest),2));expect(r.outputs.main[3]).toEqual(new Float32Array(128).fill(f(largest*tiny)));expect(r.diagnostics.scrubbedSamples).toBe(0);
});

test('subnormal rate/velocity and tiny granular position preserve meaningful output against full finite PCM',async()=>{
 const largest=f(3.4028234663852886e38),tiny=2**-149,rate=48000,data=Float32Array.of(0,largest);
 const p=defineProcessor(()=>{
  const sample=instantiate(residentSample,{capacity:2,sourceSampleRate:rate},{name:'asset'}),load=event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:8});load.onReceive(x=>sample.load(x.data));
  const player=instantiate(samplePlayer,{sampleRate:rate,sample,loop:true},{name:'player'});
  const zone=instantiate(multisamplePlayer,{sampleRate:rate,zones:[{sample,keyLow:0,keyHigh:127,velocityLow:0,velocityHigh:1,rootKey:60,loop:true,startFrame:1,endFrame:2}]},{name:'zone'});
  const grains=instantiate(granularSource,{sampleRate:rate,sample,maxGrains:1},{name:'grains'}),out=audioOutput({channels:3,name:'main'});
  return{process(){forSample(i=>{
   const base={gate:bool(true),trigger:bool(false),reset:bool(false),rate:f32(tiny)};
   out.ch(0).at(i).write(player.tick(base).output);
   out.ch(1).at(i).write(zone.tick({...base,key:f32(60),velocity:f32(tiny)}).output);
   out.ch(2).at(i).write(grains.tick({...base,positionFrames:f32(tiny),jitterFrames:f32(0),durationSeconds:f32(3/rate),densityHz:f32(0)}).output);
  });}};
 });
 const result=await renderOffline(p,{sampleRate:rate,duration:duration(128,rate),messages:[{name:'load',payload:{data}}]});
 expect(result.outputs.main[0]).toEqual(Float32Array.from({length:128},(_,n)=>f(n*tiny*largest)));expect(result.outputs.main[1]).toEqual(new Float32Array(128).fill(f(tiny*largest)));
 const expected=new Float32Array(128);expected[1]=f(2*tiny*largest);expect(result.outputs.main[2]).toEqual(expected);expect(result.diagnostics.scrubbedSamples).toBe(0);
});

test('shared resident read scratch cannot clobber deferred values from different positions or regions',async()=>{
 const p=defineProcessor(()=>{
  const sample=instantiate(residentSample,{capacity:8,sourceSampleRate:48000},{name:'asset'}),load=event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:32});load.onReceive(x=>sample.load(x.data));
  const out=audioOutput({channels:5,name:'main'});return{process(){forSample(i=>{
   // All calls finish before ANY returned value is consumed by an output.
   const a=sample.read(f64(.25),i32(0),i32(4),false);
   const b=sample.read(f64(7.75),i32(4),i32(8),true);
   const c=sample.read(f64(100),i32(0),i32(4),true);
   const d=sample.read(f64(3.5),i32(0),i32(4),true);
   out.ch(0).at(i).write(a);out.ch(1).at(i).write(b);out.ch(2).at(i).write(c);out.ch(3).at(i).write(d);out.ch(4).at(i).write(a.add(b).sub(c).mul(d));
  });}};
 });
 const r=await renderOffline(p,{sampleRate:48000,duration:duration(128,48000),messages:[{name:'load',payload:{data:Float32Array.of(1,2,3,4,10,20,30,40)}}]});
 [1.25,17.5,1,2.5,(1.25+17.5-1)*2.5].forEach((v,ch)=>expect(r.outputs.main[ch]).toEqual(new Float32Array(128).fill(v)));
 const rest=await renderOffline(p,{sampleRate:48000,duration:duration(128,48000),restore:r.state});expect(rest.outputs.main).toEqual(r.outputs.main);expect(r.diagnostics.scrubbedSamples).toBe(0);
});
