import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { compile, inspect } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { makeProcessor, makeArpeggiatorProcessor } from './processor.ts';
const clamp=(x,l,h)=>Math.min(h,Math.max(l,x));
const reports=[], arpeggiatorReports=[];
for(const sampleRate of [44100,48000,96000]) {
  const frames=32768;
  const input=[
    Float32Array.from({length:frames},(_,n)=>n<8192?137:n<16384?137+(n%129)/8:n<24576?1000:0),
    Float32Array.from({length:frames},(_,n)=>n>=4095&&n<4100||n>=24575&&n<24580?1:0),
    Float32Array.from({length:frames},(_,n)=>n>=127&&n<140||n===8191||n===16383||n===24574?1:0),
    Float32Array.from({length:frames},(_,n)=>n<8191?63.75:n<16383?-0.25:n<24574?1049000:-1049000),
    Float32Array.from({length:frames},(_,n)=>n===0||n===4100||n===24580?1:0),
    Float32Array.from({length:frames},(_,n)=>n<16384?0:n<24576?0.875:1),
    Float32Array.from({length:frames},(_,n)=>Math.sin(n/37)*2),
  ];
  
  const arp=await renderOffline(makeArpeggiatorProcessor(),{sampleRate,duration:1152/sampleRate,inputs:{controls:[new Float32Array(1152).fill(1000)]}});
  const expectedEvents=[];let active=null;
  for(let n=0;n<1152;n++) {
    const position=n*1000/sampleRate,step=Math.floor(position)%3,phase=position-Math.floor(position),tick=n===0||Math.floor(position)!==Math.floor((n-1)*1000/sampleRate);
    const pitch=[60,64,67][step],velocity=[100,90,80][step],gate=n<1024&&phase<[1,0.5,0][step];
    const emit=(type,note,velocity)=>expectedEvents.push({name:'notes',payload:{type,channel:0,note,velocity},atSample:n});
    if(active!==null&&(!gate||tick)){emit('noteOff',active,0);active=null;}
    if(gate&&(active===null||tick)){emit('noteOn',pitch,velocity);active=pitch;}
  }
  assert.deepEqual(arp.events,expectedEvents);assert.equal(active,null);assert.equal(arp.diagnostics.scrubbedSamples,0);
  arpeggiatorReports.push({sampleRate,frames:1152,events:arp.events.length,eventMismatches:0,finalActiveNote:null,scrubbedSamples:0});

  const processor=makeProcessor();
  const result=await renderOffline(processor,{sampleRate,duration:(frames-0.25)/sampleRate,inputs:{controls:input}});
  assert.equal(result.diagnostics.scrubbedSamples,0);
  let units=0,pending=true,previousSeek=false,age=-1,previousTrigger=false,seed=19,random=.25,hold=0;
  let maxPhaseError=0,maxEnvelopeError=0,maxRandomError=0,boundaryMismatches=0,tickCount=0;
  const threshold=sampleRate*60;
  for(let n=0;n<frames;n++) {
    const reset=input[1][n]>0,seek=input[2][n]>0&&!previousSeek&&!reset;
    if(reset)units=0;else if(seek){const p=clamp(input[3][n],-1048576,1048576);units=((p%64+64)%64)*threshold;}
    const step=Math.floor(units/threshold),phase=(units-step*threshold)/threshold;
    const tick=!reset&&(seek||pending);
    if(result.outputs.main[0][n]!==step||result.outputs.main[2][n]!==Number(tick))boundaryMismatches++;
    maxPhaseError=Math.max(maxPhaseError,Math.abs(result.outputs.main[1][n]-phase));
    assert.equal(result.outputs.main[3][n],(step-32)/32);
    const gate=step%3===0?0:step%3===1?1:0.25;
    assert.equal(result.outputs.main[4][n],Number(!reset&&phase<gate));
    if(reset)age=-1;else if(input[4][n]&&!previousTrigger)age=1;else if(age>=0)age=age%136+1;
    let target=-1,segment=0;
    if(age>=0) {
      let end=0;
      for(let j=0;j<16;j++) {
        if(age>end){const t=Math.min(1,(age-end)/(j+1));target=-1+j/8+t/8;segment=j;}
        end+=j+1;
      }
    }
    maxEnvelopeError=Math.max(maxEnvelopeError,Math.abs(result.outputs.main[5][n]-target));
    assert.equal(result.outputs.main[6][n],Number(age<0));assert.equal(result.outputs.main[7][n],segment);
    if(reset){seed=19;random=.25;hold=0;}else if(tick){
      seed=Number(BigInt(seed)*16807n%2147483647n);
      random=input[5][n]*random+(1-input[5][n])*(2*(seed-1)/2147483645-1);hold=input[6][n];
    }
    maxRandomError=Math.max(maxRandomError,Math.abs(result.outputs.main[8][n]-random));
    assert.equal(result.outputs.main[9][n],hold);
    tickCount+=Number(tick);
    const oldStep=step;
    if(!reset)units+=input[0][n]*32;
    if(units>=64*threshold)units-=64*threshold;
    pending=reset||Math.floor(units/threshold)!==oldStep;
    previousSeek=input[2][n]>0;previousTrigger=input[4][n]>0;
  }
  assert.equal(boundaryMismatches,0);assert(maxPhaseError<7e-8);assert(maxEnvelopeError<8e-8);assert(maxRandomError<8e-8);
  const first=await renderOffline(processor,{sampleRate,duration:(8192-.25)/sampleRate,inputs:{controls:input.map(c=>c.slice(0,8192))}});
  const resumed=await renderOffline(processor,{sampleRate,duration:(frames-8192-.25)/sampleRate,inputs:{controls:input.map(c=>c.slice(8192))},restore:first.state});
  result.outputs.main.forEach((c,ch)=>assert.deepEqual(resumed.outputs.main[ch],c.slice(8192)));
  reports.push({sampleRate,frames,tickCount,boundaryMismatches,maxPhaseError,maxEnvelopeError,maxRandomError,scrubbedSamples:result.diagnostics.scrubbedSamples,snapshotBytes:result.state.byteLength,
    slots:Object.keys(inspect(result.state).slots).length});
}
const compiled=await compile(makeProcessor(),{sampleRate:48000}),instance=await compiled.driver.instantiate();
for(let ch=0;ch<7;ch++)instance.writeInput('controls',ch,new Float32Array(128).fill(ch===0?137:0));
const memoryBytes=instance.memory.buffer.byteLength;
for(let n=0;n<128;n++)instance.process();
const ms=[];for(let n=0;n<1024;n++){const start=performance.now();instance.process();ms.push(performance.now()-start);}
assert.equal(instance.memory.buffer.byteLength,memoryBytes);assert.equal(instance.scrubbedSamples(),0);ms.sort((a,b)=>a-b);
const cost={wasmBytes:compiled.wasm.byteLength,wasmSHA256:createHash('sha256').update(compiled.wasm).digest('hex'),memoryBytes,blocks:1024,warmup:128,p50Ms:ms[512],p99Ms:ms[1013],maxMs:ms.at(-1),limitation:'Local Node driver wall-clock diagnostic, fixed controls, excludes copies and browser scheduling; not real-time acceptance.'};
writeFileSync('control-modulation-results.json',JSON.stringify({status:'CANDIDATE',reports,arpeggiatorReports,cost},null,2));
console.log(JSON.stringify({reports,arpeggiatorReports,cost}));
