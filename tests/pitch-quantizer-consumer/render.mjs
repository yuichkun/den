import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { compile } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { makeProcessor } from './processor.ts';
const configs=[{pitchClasses:[11,7,0,5,2,9,4]},{pitchClasses:[0,0.0001,2.375,11.75],hysteresis:0.125},{pitchClasses:[6],hysteresis:12}];
const frames=8192,values=[NaN,Infinity,-Infinity,-1e30,1e30,0,-0,2**-149,-(2**-149),1,1.25,1.2500001192092896,0.75,0.7499999403953552,11,11.5,11.75,11.750000953674316,12,12.001,-12,-11.999,16380,16380.0009765625,-16380,-16379.9990234375];
const input=[Float32Array.from({length:frames},(_,n)=>n%3?values[n%values.length]:-130+n/31),Float32Array.from({length:frames},(_,n)=>n>=127&&n<=132||n>=4095&&n<=4100?1:0)];
function reference(config) {
  const degrees=config.pitchClasses.map(x=>Math.fround(x)||0).sort((a,b)=>a-b),h=Math.fround(config.hysteresis??0);let old;
  return Array.from(input[0],(v,n)=>{
    const x=Number.isNaN(v)?0:Math.min(16384,Math.max(-16384,v)),q=Math.floor(x/12);
    const candidates=[];
    for(let octave=q-2;octave<=q+2;octave++)degrees.forEach((degree,index)=>{const pitch=octave*12+degree;candidates.push({pitch,index,octave,distance:Math.abs(x-pitch)});});
    candidates.sort((a,b)=>a.distance-b.distance||a.pitch-b.pitch||a.index-b.index);
    let keep=false;
    if(old&&h>0&&!input[1][n]) {
      const i=old.index,prev=i===0?degrees.at(-1)-12:degrees[i-1],next=i===degrees.length-1?degrees[0]+12:degrees[i+1],base=old.octave*12;
      keep=x>=base+((prev+degrees[i])/2-h)&&x<=base+((degrees[i]+next)/2+h);
    }
    old=keep?old:candidates[0];return [Math.fround(old.pitch),old.index,old.octave];
  });
}
const expected=configs.map(reference),reports=[];
for(const sampleRate of [44100,48000,96000]) {
  const processor=makeProcessor(configs),result=await renderOffline(processor,{sampleRate,duration:(frames-.25)/sampleRate,inputs:{control:input}});
  expected.forEach((rows,unit)=>rows.forEach((row,n)=>row.forEach((x,ch)=>assert.equal(result.outputs.main[unit*3+ch][n],x,`rate ${sampleRate} unit ${unit} frame ${n} channel ${ch}`))));
  assert.equal(result.diagnostics.scrubbedSamples,0);
  const split=4096,first=await renderOffline(processor,{sampleRate,duration:(split-.25)/sampleRate,inputs:{control:input.map(c=>c.slice(0,split))}});
  const resumed=await renderOffline(processor,{sampleRate,duration:(frames-split-.25)/sampleRate,inputs:{control:input.map(c=>c.slice(split))},restore:first.state});
  result.outputs.main.forEach((channel,ch)=>assert.deepEqual(resumed.outputs.main[ch],channel.slice(split)));
  reports.push({sampleRate,frames,comparisons:frames*configs.length*3,mismatches:0,scrubbedSamples:0,snapshotBytes:result.state.byteLength,snapshotExact:true});
}
const large=makeProcessor([{pitchClasses:Array.from({length:128},(_,i)=>i*12/128),hysteresis:0.03125}]);
const start=performance.now(),compiled=await compile(large,{sampleRate:48000}),compileMs=performance.now()-start,instance=await compiled.driver.instantiate();
instance.writeInput('control',0,Float32Array.from({length:128},(_,i)=>-64+i));instance.writeInput('control',1,new Float32Array(128));
const memoryBytes=instance.memory.buffer.byteLength;
for(let n=0;n<64;n++)instance.process();
const times=[];for(let n=0;n<512;n++){const t=performance.now();instance.process();times.push(performance.now()-t);}
assert.equal(instance.memory.buffer.byteLength,memoryBytes);assert.equal(instance.scrubbedSamples(),0);times.sort((a,b)=>a-b);
const cost={degrees:128,compileMs,wasmBytes:compiled.wasm.byteLength,wasmSHA256:createHash('sha256').update(compiled.wasm).digest('hex'),memoryBytes,blocks:512,warmup:64,p50Ms:times[256],p99Ms:times[506],maxMs:times.at(-1),limitation:'Local native Node driver diagnostic; excludes copies and browser scheduling. Not hardware real-time acceptance.'};
writeFileSync('pitch-quantizer-results.json',JSON.stringify({status:'CANDIDATE',reports,cost},null,2));console.log(JSON.stringify({reports,cost}));
