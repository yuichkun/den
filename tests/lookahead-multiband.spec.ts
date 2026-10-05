import { expect, test as testCase } from 'vitest';
const test=(name:string,fn:()=>void|Promise<void>,timeout=120000)=>testCase(name,fn,timeout);
import { audioInput, audioOutput, compile, defineProcessor, f32, forSample, inspect, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { lookaheadLimiter } from '../src/lookahead-limiter.js';
import { multibandDynamics } from '../src/multiband-dynamics.js';
import { makeLimiter, makeMultiband } from './lookahead-multiband-fixture.js';
import { add, limiterReference, mul, response, splitReference, transfer } from './lookahead-multiband-consumer/oracle.mjs';
const rates=[44100,48000,96000];
const fill=(n:number,v=0)=>new Float32Array(n).fill(v);
const rows=(n:number,f:(i:number)=>number[])=>{const r=Array.from({length:n},(_,i)=>f(i));return r[0].map((_,ch)=>Float32Array.from(r,x=>x[ch]));};
function close(actual:ArrayLike<number>,expected:ArrayLike<number>,absolute=2e-6,relative=0){
 expect(actual.length).toBe(expected.length);
 let worst=-Infinity,index=0;
 for(let i=0;i<actual.length;i++){const over=Math.abs(actual[i]-expected[i])-(absolute+relative*Math.abs(expected[i]));if(over>worst){worst=over;index=i;}}
 expect(worst,`sample${index}: ${actual[index]} vs ${expected[index]}`).toBeLessThanOrEqual(0);
}
async function render(p:ReturnType<typeof makeLimiter>,rate:number,input:Float32Array[],restore?:Uint8Array){
 const r=await renderOffline(p,{sampleRate:rate,duration:(input[0].length-.25)/rate,inputs:{main:input},restore});
 expect(r.outputs.main[0].length).toBe(input[0].length);expect(r.diagnostics.scrubbedSamples).toBe(0);
 for(const ch of r.outputs.main)expect(ch.every(Number.isFinite)).toBe(true);
 return r;
}
function verifyLimiter(result:Awaited<ReturnType<typeof render>>,inputs:Float32Array[],rate:number,delay:number){
 const expected=limiterReference(inputs,rate,delay);
 for(let ch=0;ch<8;ch++)close(result.outputs.main[ch],expected[ch],ch===4||ch===5?2**-149:2e-6,2e-6);
 expect(result.outputs.main[2]).toEqual(Float32Array.from(expected[2]));
 expect(result.outputs.main[3]).toEqual(Float32Array.from(expected[3]));
 expect(result.outputs.main[5]).toEqual(Float32Array.from(expected[5]));
 let excess=-Infinity;for(let i=0;i<inputs[0].length;i++)for(let ch=0;ch<2;ch++)excess=Math.max(excess,Math.abs(result.outputs.main[ch][i])-result.outputs.main[7][i]);
 expect(excess).toBeLessThanOrEqual(0);
}
for(const rate of rates){
 test(`limiter exact inclusive window, first fill/reset/wrap, linked ceiling and release at${rate}`,async()=>{
  for(const delay of [0,1,6,127,128,257,2048]){
   const n=delay===2048?8192:1024;
   const input=rows(n,i=>[i%29===0?4:0.4*Math.sin(i*.23),i%43===0?-8:-0.1*Math.cos(i*.11),i<n/2?-6:-24,i%233<120?0:.012,
    i===33||i===129||i===513||i===Math.floor(n*.6)?1:0]);
   verifyLimiter(await render(makeLimiter(rate,delay),rate,input),input,rate,delay);
  }
 },120000);
 test(`limiter latency, held reset and impulse anticipation at${rate}`,async()=>{
  for(const delay of [0,1,64]){
   const input=rows(512,i=>[i===128?2:0,i===128?-.5:0,-6,0,0]);
   const out=await render(makeLimiter(rate,delay),rate,input);
   expect(out.outputs.main[0].findIndex(x=>x!==0)).toBe(128+delay);
   expect(out.outputs.main[6][128]).toBeCloseTo(10**(-6/20)/2,6);
   for(let n=128;n<=128+delay;n++)expect(out.outputs.main[4][n]).toBe(2);
   expect(out.outputs.main[4][129+delay]).toBe(0);
   const held=rows(256,()=>[2,-.5,-6,0,1]);
   const h=await render(makeLimiter(rate,delay),rate,held);verifyLimiter(h,held,rate,delay);
   if(delay)expect(h.outputs.main[0]).toEqual(fill(256));else expect(h.outputs.main[0][0]).toBeCloseTo(10**(-6/20),6);
  }
 });
 test(`limiter arbitrary ceiling edits, malformed controls and full/subnormal f32 headroom at${rate}`,async()=>{
  const extrema=[2**-149,1e-35,1e-20,0,1,3.4028234663852886e38,NaN,Infinity,-Infinity];
  const input=rows(512,i=>[extrema[i%extrema.length],-extrema[(i+3)%extrema.length],i%4===0?NaN:i%4===1?-120:i%4===2?20:-1000,i%3===0?NaN:i%3===1?30:-1,i%17===0?1:0]);
  verifyLimiter(await render(makeLimiter(rate,6),rate,input),input,rate,6);
  for(const amplitude of [2**-149,1e-35,1e-20,3.4028234663852886e38]){
   const x=[fill(256,amplitude),fill(256,-amplitude),fill(256,-120),fill(256),fill(256)];
   const y=await render(makeLimiter(rate,1),rate,x);verifyLimiter(y,x,rate,1);
   const expected=Math.min(amplitude,10**-6);
   expect(Math.abs(y.outputs.main[0][255]-expected)).toBeLessThanOrEqual(expected*2e-6+2**-149);
   expect(y.outputs.main[0][255]).toBeGreaterThan(0);
  }
 });
 test(`limiter persistent snapshot and independent instance state at${rate}`,async()=>{
  const input=rows(2048,i=>[2*Math.sin(i*.13),-.5*Math.cos(i*.17),i<1200?-3:-18,.035,i===1700?1:0]);
  const p=makeLimiter(rate,257),whole=await render(p,rate,input),first=await render(p,rate,input.map(x=>x.slice(0,768)));
  const resumed=await render(p,rate,input.map(x=>x.slice(768)),first.state);
  whole.outputs.main.forEach((ch,i)=>expect(resumed.outputs.main[i]).toEqual(ch.slice(768)));
  expect(first.state.byteLength).toBe(whole.state.byteLength);
  const dual=defineProcessor(()=>{const input=audioInput({name:'main',channels:5}),output=audioOutput({name:'main',channels:2});
   const a=instantiate(lookaheadLimiter,{sampleRate:rate,lookaheadSamples:17},{name:'a'}),b=instantiate(lookaheadLimiter,{sampleRate:rate,lookaheadSamples:17},{name:'b'});
   return{process(){forSample(i=>{const c={ceilingDb:f32(-6),release:f32(.01),reset:input.ch(4).at(i).gt(0)};
    const x=a.tick(input.ch(0).at(i),input.ch(1).at(i),c),y=b.tick(f32(0),f32(0),c);output.ch(0).at(i).write(x.left);output.ch(1).at(i).write(y.left);});}};});
  const d=await render(dual,rate,input);expect(d.outputs.main[1]).toEqual(fill(2048));expect(d.outputs.main[0].some(x=>x!==0)).toBe(true);
 });
 test(`multiband independent LR4 impulses and APlo×APhi complex reconstruction at${rate}`,async()=>{
  for(const [lo,hi]of [[200,2000],[1000,1000],[20,Math.min(20000,.45*rate)]]){
   const input=rows(16384,i=>[i===0?1:0,i===0?-.5:0,lo,hi,1,-18,0,0,0]);
   const y=await render(makeMultiband(rate),rate,input),bands=splitReference(input[0],rate,lo,hi);
   for(let ch=0;ch<3;ch++)close(y.outputs.main[4+ch],bands[ch],4e-6);
   close(y.outputs.main[0],Float64Array.from(input[0],(_,i)=>bands[0][i]+bands[1][i]+bands[2][i]),5e-6);
   expect(y.outputs.main[0]).toEqual(y.outputs.main[2]);
   const right=splitReference(input[1],rate,lo,hi);
   close(y.outputs.main[1],Float64Array.from(input[1],(_,i)=>right[0][i]+right[1][i]+right[2][i]),5e-6);
   for(const hz of [0,20,100,lo,hi,5000,Math.min(18000,.4*rate),rate/2]){
    const expected=mul(add(transfer(rate,lo,'low',hz),transfer(rate,lo,'high',hz)),add(transfer(rate,hi,'low',hz),transfer(rate,hi,'high',hz)));
    const actual=response(y.outputs.main[0],hz,rate);
    expect(Math.hypot(actual.re-expected.re,actual.im-expected.im)).toBeLessThan(2e-5);
    expect(Math.abs(actual.gain-1)).toBeLessThan(2e-5);
   }
   expect(y.outputs.main[0][0]).not.toBe(1);
   if(lo===hi)expect(y.outputs.main[5].some(x=>Math.abs(x)>1e-4)).toBe(true);
  }
 },120000);
 test(`multiband independent per-band compression and a-rate gain controls at${rate}`,async()=>{
  const input=rows(4096,i=>[.75*Math.sin(i*.02)+.5*Math.cos(i*.7),-.25*Math.cos(i*.03),200,2000,i<512?1:i<2000?4:100,i<1024?-12:-24,0,0,0]);
  const y=await render(makeMultiband(rate),rate,input),l=splitReference(input[0],rate,200,2000),r=splitReference(input[1],rate,200,2000);
  for(let i=0;i<input[0].length;i++){
   let sumL=0,sumR=0;
   for(let band=0;band<3;band++){
    const peak=Math.max(Math.abs(l[band][i]),Math.abs(r[band][i])),level=20*Math.log10(Math.max(1e-30,peak));
    const reduction=Math.min(60,Math.max(0,(level-input[5][i])*(1-1/input[4][i]))),gain=10**(-reduction/20);
    expect(Math.abs(y.outputs.main[10+band][i]-gain)).toBeLessThan(2e-5);
    expect(Math.abs(y.outputs.main[4+band][i]-l[band][i]*gain)).toBeLessThan(5e-6);
    sumL+=l[band][i]*gain;sumR+=r[band][i]*gain;
   }
   expect(Math.abs(y.outputs.main[0][i]-sumL)).toBeLessThan(1e-5);expect(Math.abs(y.outputs.main[1][i]-sumR)).toBeLessThan(1e-5);
  }
 });
 test(`multiband cutoff sorting/clamps, automation/reset/snapshot and finite caller headroom at${rate}`,async()=>{
  const input=rows(4096,i=>[i%47===0?NaN:16*Math.sin(i*.17),i%59===0?Infinity:-8*Math.cos(i*.13),i%4===0?NaN:i%4===1?-1:i%4===2?1e6:2000,
   i%5===0?Infinity:i%5===1?20:i%5===2?30000:200,i<2048?1:4,-24,.003,.1,i===0||i===127||i===128||i===3001?1:0]);
  const p=makeMultiband(rate),y=await render(p,rate,input);
  const first=await render(p,rate,input.map(x=>x.slice(0,2048))),continued=await render(p,rate,input.map(x=>x.slice(2048)),first.state);
  y.outputs.main.forEach((ch,i)=>expect(continued.outputs.main[i]).toEqual(ch.slice(2048)));
  for(const ch of y.outputs.main.slice(0,10))expect(ch.every(x=>Math.abs(x)<128)).toBe(true);
  const sorted=rows(1024,i=>[Math.sin(i*.13),-.5*Math.cos(i*.3),200,2000,1,-12,0,0,0]);
  const a=await render(p,rate,sorted),b=await render(p,rate,[sorted[0],sorted[1],sorted[3],sorted[2],...sorted.slice(4)]);
  expect(a.outputs.main).toEqual(b.outputs.main);
  const reset=rows(512,i=>[i<128?1:0,i<128?-1:0,200,2000,4,-24,.01,.1,i===128?1:0]);
  const clean=await render(p,rate,reset);for(const ch of clean.outputs.main.slice(0,10))expect(ch.slice(128)).toEqual(fill(384));
 });
}
test('construction rejects invalid capacities, rates and multiband cardinality',()=>{
 for(const rate of [0,7999,192001,NaN,Infinity,48000.5]){expect(()=>makeLimiter(rate,1)).toThrow(/sampleRate/);expect(()=>makeMultiband(rate)).toThrow(/sampleRate/);}
 for(const n of [-1,0.5,2049,NaN,Infinity])expect(()=>makeLimiter(48000,n)).toThrow(/lookaheadSamples/);
 expect(()=>defineProcessor(()=>{instantiate(multibandDynamics,{sampleRate:48000,bands:[] as never});return{process(){}};})).toThrow(/three/);
});
test('maximum limiter capacity remains fixed-memory and bounded compiled graph',async()=>{
 const p=makeLimiter(48000,2048),compiled=await compile(p,{sampleRate:48000}),instance=await compiled.driver.instantiate();
 expect(compiled.wasm.byteLength).toBeLessThan(100000);
 const before=instance.memory.buffer.byteLength;
 for(let ch=0;ch<5;ch++)instance.writeInput('main',ch,fill(128,ch<2?2:ch===2?-6:0));
 for(let n=0;n<256;n++)instance.process();
 expect(instance.memory.buffer.byteLength).toBe(before);expect(instance.scrubbedSamples()).toBe(0);
 const state=await render(p,48000,[fill(256,1),fill(256),fill(256,-6),fill(256),fill(256)]);
 expect(Object.keys(inspect(state.state).slots)).toHaveLength(7);
});
for(const rate of rates)test(`multiband distinct gate/expander/duck mapping and independent gain ballistics at${rate}`,async()=>{
 const configs=[{mode:'peak',operation:'gate'},{mode:'rms',operation:'expander'},{mode:'peak',operation:'duck'}] as const;
 const input=rows(2048,i=>[i<1500?.75*Math.sin(i*.023)+.4*Math.cos(i*.8):0,i<1500?-.3*Math.cos(i*.15):0,200,2000,4,-18,.002,.013,0]);
 const y=await render(makeMultiband(rate,configs),rate,input),left=splitReference(input[0],rate,200,2000),right=splitReference(input[1],rate,200,2000);
 const attenuation=[0,0,0],active=[false,false,false];
 for(let i=0;i<input[0].length;i++)for(let band=0;band<3;band++){
  const level=20*Math.log10(Math.max(1e-30,Math.abs(left[band][i]),Math.abs(right[band][i])));
  active[band]=level>=-18||active[band]&&level>-21;
  const target=band===0?(active[band]?0:60):band===1?Math.min(60,Math.max(0,(-18-level)*3)):(active[band]?60:0);
  const opens=band<2,time=target>attenuation[band]?input[opens?7:6][i]:input[opens?6:7][i];
  attenuation[band]+=(target-attenuation[band])*-Math.expm1(-1/(rate*time));
  const expected=10**(-attenuation[band]/20);
  expect(Math.abs(y.outputs.main[10+band][i]-expected)).toBeLessThan(3e-5);
 }
});
test('multiband preserves tiny histories and rejects the uncompensated equal-cutoff reconstruction',async()=>{
 const rate=48000,input=rows(1024,i=>[i<512?1e-35:0,0,1000,1000,1,-18,0,0,0]);
 const y=await render(makeMultiband(rate),rate,input),bands=splitReference(input[0],rate,1000,1000);
 for(let ch=0;ch<3;ch++)close(y.outputs.main[4+ch],bands[ch],2**-149,2e-5);
 expect(y.outputs.main[0][511]).toBeGreaterThan(0);expect(y.outputs.main[0][512]).not.toBe(0);
 const first=await render(makeMultiband(rate),rate,input.map(x=>x.slice(0,512))),next=await render(makeMultiband(rate),rate,input.map(x=>x.slice(512)),first.state);
 y.outputs.main.forEach((ch,i)=>expect(next.outputs.main[i]).toEqual(ch.slice(512)));
 const lp=transfer(rate,1000,'low',1000),hp=transfer(rate,1000,'high',1000);
 const naive=add(lp,mul(hp,add(lp,hp))),compensated=mul(add(lp,hp),add(lp,hp));
 expect(Math.hypot(naive.re,naive.im)).toBeLessThan(1e-6);
 expect(Math.hypot(compensated.re,compensated.im)).toBeCloseTo(1,6);
});
for(const rate of rates)test(`multiband genuinely unequal per-band control records at${rate}`,async()=>{
 const input=rows(2048,i=>[.5*Math.sin(i*.017)+.5*Math.cos(i*.4),-.4*Math.cos(i*.2),200,2000,i<1024?2:4,i<700?-12:-18,0,0,0]);
 const y=await render(makeMultiband(rate,undefined,true),rate,input),left=splitReference(input[0],rate,200,2000),right=splitReference(input[1],rate,200,2000);
 for(let band=0;band<3;band++){
  const expected=Float64Array.from(input[0],(_,i)=>{const level=20*Math.log10(Math.max(1e-30,Math.abs(left[band][i]),Math.abs(right[band][i]))),threshold=input[5][i]-band*6,ratio=input[4][i]+band*2;return 10**(-Math.min(60,Math.max(0,(level-threshold)*(1-1/ratio)))/20);});
  close(y.outputs.main[10+band],expected,2e-5);
  close(y.outputs.main[4+band],Float64Array.from(expected,(g,i)=>g*left[band][i]),5e-6);
 }
});
test('multiband materializes stage boundaries with a bounded WASM artifact',async()=>{
 const p=makeMultiband(48000),compiled=await compile(p,{sampleRate:48000});
 // The unmaterialized composition was 6.75MB. Guard the bounded construction,
 // without turning wall-clock performance into an unstable acceptance oracle.
 expect(compiled.wasm.byteLength).toBeLessThan(200000);
 const input=rows(128,i=>[Math.sin(i*.1),0,200,2000,1,-18,0,0,0]),state=await render(p,48000,input);
 expect(Object.keys(inspect(state.state).slots).filter(name=>name.includes('StageScratchScaled'))).toHaveLength(0);
});
