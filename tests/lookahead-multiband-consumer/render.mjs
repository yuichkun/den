import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { compile } from '@unworklet/core';
import { encodeWav, renderOffline } from '@unworklet/offline';
import { makeLimiter, makeMultiband } from './processor.ts';
import { add, limiterReference, mul, response, splitReference, transfer } from './oracle.mjs';
const reports=[], performanceReports=[];
const rows=(n,f)=>{const r=Array.from({length:n},(_,i)=>f(i));return r[0].map((_,ch)=>Float32Array.from(r,x=>x[ch]));};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const close=(actual,expected,absolute=2e-6,relative=0)=>{let max=0;assert.equal(actual.length,expected.length);for(let i=0;i<actual.length;i++){const e=Math.abs(actual[i]-expected[i]);assert(e<=absolute+relative*Math.abs(expected[i]),`sample ${i}: ${actual[i]} vs ${expected[i]}`);max=Math.max(max,e);}return max;};
async function render(p,rate,input,restore){const r=await renderOffline(p,{sampleRate:rate,duration:(input[0].length-.25)/rate,inputs:{main:input},restore});assert.equal(r.outputs.main[0].length,input[0].length);assert.equal(r.diagnostics.scrubbedSamples,0);for(const ch of r.outputs.main)for(const x of ch)assert(Number.isFinite(x));return r;}
async function snapshot(p,rate,input,whole){const split=8192,first=await render(p,rate,input.map(x=>x.slice(0,split))),second=await render(p,rate,input.map(x=>x.slice(split)),first.state);whole.outputs.main.forEach((ch,i)=>assert.deepEqual(second.outputs.main[i],ch.slice(split)));assert.equal(first.state.byteLength,whole.state.byteLength);}
function audioFiles(name,rate,result){const wav=`candidate-${name}-${rate}.wav`,raw=`candidate-${name}-${rate}.f32`;writeFileSync(wav,encodeWav(result.outputs.main.slice(0,2),rate));writeFileSync(raw,Buffer.concat(result.outputs.main.slice(0,2).map(ch=>Buffer.from(ch.buffer,ch.byteOffset,ch.byteLength))));return{wav,raw,wavSHA256:hash(Buffer.from(encodeWav(result.outputs.main.slice(0,2),rate)))};}
for(const rate of [44100,48000,96000]){
 const frames=16384,delay=257;
 const inputs=rows(frames,n=>[n%997===0?8:2*Math.sin(2*Math.PI*110*n/rate),n%1501===0?-16:-.5*Math.cos(2*Math.PI*730*n/rate),n<4096?-3:n<10000?-18:-1,n<7000?.03:0,n===12001?1:0]);
 const p=makeLimiter(rate,delay),out=await render(p,rate,inputs),expected=limiterReference(inputs,rate,delay);
 const errors=out.outputs.main.map((ch,i)=>close(ch,expected[i],i===4||i===5?2**-149:2e-6,2e-6));
 assert.deepEqual(out.outputs.main[2],Float32Array.from(expected[2]));assert.deepEqual(out.outputs.main[3],Float32Array.from(expected[3]));assert.deepEqual(out.outputs.main[5],Float32Array.from(expected[5]));
 for(let n=0;n<frames;n++)for(let ch=0;ch<2;ch++)assert(Math.abs(out.outputs.main[ch][n])<=out.outputs.main[7][n]);
 await snapshot(p,rate,inputs,out);
 reports.push({module:'lookaheadLimiter',rate,frames,delay,errors,scrubbedSamples:out.diagnostics.scrubbedSamples,stateBytes:out.state.byteLength,files:audioFiles('lookahead-limiter',rate,out)});
 const impulse=rows(frames,n=>[n===0?1:0,n===0?-.5:0,200,2000,1,-18,0,0,0]);
 const m=makeMultiband(rate),cross=await render(m,rate,impulse),bands=splitReference(impulse[0],rate,200,2000);
 const bandErrors=bands.map((band,i)=>close(cross.outputs.main[4+i],band,4e-6));
 const complex=[];
 for(const hz of [0,20,100,200,1000,2000,5000,Math.min(18000,.4*rate),rate/2]){
  const actual=response(cross.outputs.main[0],hz,rate),target=mul(add(transfer(rate,200,'low',hz),transfer(rate,200,'high',hz)),add(transfer(rate,2000,'low',hz),transfer(rate,2000,'high',hz)));
  const error=Math.hypot(actual.re-target.re,actual.im-target.im);assert(error<2e-5);assert(Math.abs(actual.gain-1)<2e-5);complex.push({hz,...actual,error});
 }
 const musical=rows(frames,n=>[.75*Math.sin(2*Math.PI*110*n/rate)+.25*Math.sin(2*Math.PI*4300*n/rate),-.3*Math.cos(2*Math.PI*660*n/rate),200,2000,n<6000?4:8,n<10000?-18:-30,0,0,0]);
 const music=await render(m,rate,musical),l=splitReference(musical[0],rate,200,2000),r=splitReference(musical[1],rate,200,2000);
 let audioError=0,gainError=0;
 for(let n=0;n<frames;n++){
  let left=0,right=0;
  for(let band=0;band<3;band++){
   const level=20*Math.log10(Math.max(1e-30,Math.abs(l[band][n]),Math.abs(r[band][n]))),reduction=Math.min(60,Math.max(0,(level-musical[5][n])*(1-1/musical[4][n]))),gain=10**(-reduction/20);
   gainError=Math.max(gainError,Math.abs(music.outputs.main[10+band][n]-gain));left+=l[band][n]*gain;right+=r[band][n]*gain;
  }
  audioError=Math.max(audioError,Math.abs(music.outputs.main[0][n]-left),Math.abs(music.outputs.main[1][n]-right));
 }
 assert(audioError<1e-5);assert(gainError<2e-5);await snapshot(m,rate,musical,music);
 reports.push({module:'multibandDynamics',rate,frames,bandErrors,complex,audioError,gainError,scrubbedSamples:music.diagnostics.scrubbedSamples,stateBytes:music.state.byteLength,files:audioFiles('multiband-dynamics',rate,music)});
 for(const [name,processor,input]of [['lookaheadLimiter-max2048',makeLimiter(rate,2048),inputs],['multibandDynamics',m,musical]]){
  const start=performance.now(),compiled=await compile(processor,{sampleRate:rate}),compileMs=performance.now()-start,instance=await compiled.driver.instantiate(),beforeMemory=instance.memory.buffer.byteLength;
  input.forEach((ch,i)=>instance.writeInput('main',i,ch.slice(0,128)));for(let n=0;n<128;n++)instance.process();
  const timings=[];for(let n=0;n<512;n++){const t=performance.now();instance.process();timings.push(performance.now()-t);}
  assert.equal(instance.memory.buffer.byteLength,beforeMemory);assert.equal(instance.scrubbedSamples(),0);timings.sort((a,b)=>a-b);
  performanceReports.push({name,rate,compileMs,wasmBytes:compiled.wasm.byteLength,wasmSHA256:hash(compiled.wasm),memoryBytes:beforeMemory,warmupBlocks:128,measuredBlocks:512,framesPerBlock:128,p50Ms:timings[256],p99Ms:timings[Math.floor(.99*512)],maxMs:timings.at(-1),budgetMs:128000/rate,deadlineExceedances:timings.filter(t=>t>128000/rate).length,
   limitation:'Unloaded local Node driver timing, repeating the first input block, excluding input/output copies and browser scheduling. Not a real-time acceptance gate.'});
 }
}
writeFileSync('lookahead-multiband-results.json',JSON.stringify({status:'CANDIDATE',reports,performanceReports},null,2));
console.log(JSON.stringify({status:'CANDIDATE',reports,performanceReports}));
