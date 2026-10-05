import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {decodeSnapshot,decodeScalar} from '@unworklet/core';
import {renderOffline} from '@unworklet/offline';
import processor from './processor.ts';
const sampleRate=48000,frames=8192;
const initial=await renderOffline(processor,{sampleRate,duration:frames/sampleRate});
const decoded=decodeSnapshot(initial.state);
const saved=Object.fromEntries(decoded.slots.filter(s=>s.kind==='param').map(s=>[s.name,Number(decodeScalar('f32',s.data))]));
assert.deepEqual(Object.keys(saved).sort(),['gain','mix','ratio','reset','time']);
assert.deepEqual(saved,{ratio:1,time:Math.fround(8/sampleRate),gain:1,mix:1,reset:0});
const live={ratio:.5,time:Math.fround(24/sampleRate),gain:2,mix:0,reset:0};
const bin=x=>{let re=0,im=0;for(let n=0;n<x.length;n++){re+=x[n]*Math.cos(2*Math.PI*n/128);im-=x[n]*Math.sin(2*Math.PI*n/128);}return{re:2*re/x.length,im:2*im/x.length};};
const reports=[];let baseline;
for(const staleQuanta of [0,1,2,3,4,7,8,17]){
 const params=Object.fromEntries(Object.keys(saved).map(k=>[k,Float32Array.from({length:frames},(_,n)=>n<128*staleQuanta?live[k]:saved[k])]));
 const r=await renderOffline(processor,{sampleRate,duration:frames/sampleRate,restore:initial.state,params});
 assert.equal(r.diagnostics.scrubbedSamples,0);assert(r.outputs.main.every(x=>x.every(Number.isFinite)));
 const out=r.outputs.main.map(x=>x.slice(-4096));if(!baseline)baseline=out;
 const sign=staleQuanta%2?-1:1;let maxPitchError=0,maxOtherSettledError=0;
 for(let n=0;n<4096;n++){
  maxPitchError=Math.max(maxPitchError,Math.abs(out[3][n]-sign*baseline[3][n]));
  for(const c of [0,1,2,4])maxOtherSettledError=Math.max(maxOtherSettledError,Math.abs(out[c][n]-baseline[c][n]));
 }
 assert(maxPitchError<1e-7);assert(maxOtherSettledError<1e-7);
 reports.push({staleQuanta,phaseAdvance:staleQuanta/32,additionalReadAge:staleQuanta*64,expectedSign:sign,pitch:bin(out[3]),source:bin(out[0]),maxPitchError,maxOtherSettledError,scrubbedSamples:0});
}
assert(Math.abs(reports[0].pitch.re-(-.006133459294851527))<2e-9);assert(Math.abs(reports[1].pitch.re-.006133459294852017)<2e-9);
const report={status:'DIAGNOSIS ONLY / NOT BROWSER CLEARANCE',method:'Public renderOffline restore into fresh native driver followed by explicitly scheduled stale AudioParams. Reproduces the known worklet-state/host-param ordering gap without claiming an in-place restore API.',sampleRate,frames,savedParams:saved,preRestoreLiveParams:live,conclusion:'One odd stale ratio quantum flips steady unity output by half a cycle; even quanta appear correct. All five saved controls applied before processing restored state yield the unchanged unity phase oracle.',hashes:Object.fromEntries(['processor.ts','node_modules/@denaudio/den/dist/windowed-pitch-shift.js','node_modules/@unworklet/core/dist/index.mjs','node_modules/@unworklet/core/dist/worklet-DGiKko0I.mjs'].map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')])),reports};
writeFileSync('review-pitch-restore-gap-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
