import assert from 'node:assert/strict';
import { renderOffline } from '@unworklet/offline';
import processor from './processor.ts';
import { envelopeReference, lfoReference, waveReference } from './reference.mjs';
const frames = 16384, phaseMaximum = 1 - 2 ** -24;
const params = {
  rate: Array.from({length:frames}, (_,n)=>n<4096?3.125:6.25),
  bpm: Array.from({length:frames}, (_,n)=>n<4096?120:180),
  hold: Array.from({length:frames}, (_,n)=>+(n>=6144&&n<12288)),
  seek: Array.from({length:frames}, (_,n)=>+(n===6144||n===8192||n===10240)),
  position: Array.from({length:frames}, (_,n)=>n<8192?.375:n<10240?-.25:-(2**-60)),
  offset: Array.from({length:frames}, (_,n)=>n>=6144&&n<10240?.125:0),
  reset: Array.from({length:frames}, (_,n)=>+(n>=12030&&n<12037)),
  bend: Array.from({length:frames}, (_,n)=>n<4096?.75:n<8192?-.75:0),
};
const reports=[];
for(const sampleRate of [44100,48000,96000]){
  let counter=0,clock=0,previousSeek=false;
  const phase=[],envRows=[],clockRows=[];
  for(let n=0;n<frames;n++){
    const reset=!!params.reset[n];if(reset)counter=0;phase.push(counter);
    envRows.push([+(counter>=1&&counter<=384),+(counter===256),+(reset||counter===0),64/sampleRate,96/sampleRate,.375,128/sampleRate,params.bend[n],-params.bend[n],params.bend[n]]);
    counter=reset?0:(counter+1)%1024;
    if(reset)clock=0;
    else if(params.seek[n]&&!previousSeek){const request=Math.fround(params.position[n]);clock=Math.min(3-2**-51,request-Math.floor(request/3)*3);}
    const step=Math.floor(clock);clockRows.push([step,Math.min(phaseMaximum,Math.fround(clock-step))]);
    if(!reset&&!params.hold[n])clock=(clock+params.rate[n]/sampleRate)%3;
    previousSeek=!!params.seek[n];
  }
  const env=envelopeReference(envRows,sampleRate);
  const rows=Array.from({length:frames},(_,n)=>[params.rate[n],params.reset[n],params.seek[n],params.position[n],params.offset[n],params.hold[n]]);
  const free=lfoReference(rows,sampleRate,'free');
  const tempo=lfoReference(rows.map((r,n)=>[params.bpm[n],...r.slice(1)]),sampleRate,'tempo',.5);
  const expected=[Float32Array.from(env,r=>r[0]),Float32Array.from(env,r=>r[1]),Float32Array.from(phase),
    ...['sine','triangle','saw','square'].flatMap(w=>[Float32Array.from(free,p=>waveReference(w,p)),Float32Array.from(free)]),
    Float32Array.from(tempo,p=>waveReference('sine',p)),Float32Array.from(tempo),
    Float32Array.from(clockRows,r=>r[0]),Float32Array.from(clockRows,r=>r[1]),
    ...Object.values(params).map(x=>Float32Array.from(x))];
  const render=(a,b,restore)=>renderOffline(processor,{sampleRate,duration:(b-a-.25)/sampleRate,
    params:Object.fromEntries(Object.entries(params).map(([name,values])=>[name,values.slice(a,b)])),...(restore?{restore}:{})});
  const whole=await render(0,frames);assert.equal(whole.outputs.main.length,23);assert.equal(whole.diagnostics.scrubbedSamples,0);
  const errors=whole.outputs.main.map((ch,k)=>{assert.equal(ch.length,frames);assert(ch.every(Number.isFinite));const e=Math.max(...ch.map((v,n)=>Math.abs(v-expected[k][n])));assert(e<2e-7,`rate${sampleRate} channel${k} error${e}`);return e;});
  // Native offline snapshots are taken after complete 128-sample quanta.
  // The retained invalid split300 probe actually rendered384 samples.
  for(const split of [128,384,4096,7296,10240,12032]){
    assert.equal(split%128,0);const first=await render(0,split),tail=await render(split,frames,first.state);
    assert.equal(first.outputs.main[0].length,split);
    tail.outputs.main.forEach((actual,ch)=>{
      const expected=whole.outputs.main[ch].slice(split);assert.equal(actual.length,expected.length);
      const a=new Uint32Array(actual.buffer,actual.byteOffset,actual.length),b=new Uint32Array(expected.buffer,expected.byteOffset,expected.length);
      const mismatch=a.findIndex((bits,n)=>bits!==b[n]);
      assert.equal(mismatch,-1,`exact continuation rate${sampleRate} split${split} channel${ch}: first mismatch ${mismatch}, ${actual[mismatch]} vs ${expected[mismatch]}`);
    });
    assert.deepEqual(tail.state,whole.state);assert.equal(tail.diagnostics.scrubbedSamples,0);
  }
  reports.push({sampleRate,frames,channels:23,errors,snapshotSplits:[128,384,4096,7296,10240,12032],scrubbedSamples:0});
}
console.log(JSON.stringify({reports,status:'CANDIDATE',runtimeStatus:'NOT_CLEARED'}));
