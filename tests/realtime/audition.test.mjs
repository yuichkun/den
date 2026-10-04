import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildConsumer} from '../../scripts/build-consumer.mjs';
import {captureRealtime} from './capture.mjs';

test('sustained packed audition meets real-time deadlines and preserves raw continuity',{timeout:240000},async()=>{
 const root=join(import.meta.dirname,'../..'),artifacts=join(root,'artifacts/realtime');
 const {consumer,output}=buildConsumer({stageSite:false});
 try {
  const results=await captureRealtime(output,artifacts);
  for(const r of results){
   assert(r.before&&r.after,'Chromium AudioContext.playbackStats is required; offline capture alone misses underruns');
   // Native oscillator is an environment control, not den's numerical contract.
   // Preserve its stats even if the runner itself stalls during that window.
   if(r.mode==='native-sine')continue;
   assert.equal(r.after.underrunEvents-r.before.underrunEvents,0,`${r.mode}: real-time underrun events`);
   assert.equal(r.after.underrunDuration-r.before.underrunDuration,0,`${r.mode}: real-time underrun duration`);
   assert(r.wallMs<5500,`${r.mode}: five seconds of samples took ${r.wallMs} ms`);
   assert.equal(r.samples,240000);assert.equal(r.zeros,0);assert.equal(r.jumps,0);
   assert(r.maxStep<(r.mode==='controls'?.0015:.00075),`${r.mode}: discontinuous sample step`);
   assert(r.quantumStep<(r.mode==='controls'?.0015:.00075),`${r.mode}: quantum-boundary discontinuity`);
   if(r.sineResidual!==null)assert(r.sineResidual<1e-6,`${r.mode}: phase reset or drift`);
  }
  // Independent native WASM processing cost, with warmed code and identical 128-frame blocks.
  const {audition}=await import(join(consumer,'audition-processor.js'));
  const {compile}=await import(join(consumer,'node_modules/@unworklet/core/dist/index.mjs'));
  const c=await compile(audition,{sampleRate:48000}),driver=await c.driver.instantiate();
  for(const d of driver.declarations)if(d.kind==='param')driver.writeParam(d.name,new Float32Array(128).fill(d.name==='gate'?1:d.default));
  for(let n=0;n<100;n++)driver.process();
  const durations=[];for(let n=0;n<1000;n++){const start=performance.now();driver.process();durations.push(performance.now()-start);}durations.sort((a,b)=>a-b);
  const cost={wasmBytes:c.wasm.length,p50:durations[500],p95:durations[950],p99:durations[990],max:durations.at(-1),budgetMs:128/48};
  assert(cost.p95<cost.budgetMs/2,'DSP lacks 50% deadline headroom on this runner');
  mkdirSync(artifacts,{recursive:true});
  writeFileSync(join(artifacts,'manifest.json'),JSON.stringify({status:'CANDIDATE — not listening-approved',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='',sampleRate:48000,cost,results,files:Object.fromEntries(results.map(r=>[r.mode+'.f32',createHash('sha256').update(readFileSync(join(artifacts,r.mode+'.f32'))).digest('hex')])),limitations:['Chromium headless; no physical mobile listening','Raw capture precedes hardware fallback; playbackStats checks that separate layer','One-second recorder warmup precedes each five-second steady window']},null,2));
  console.log(cost);
 }finally{rmSync(consumer,{recursive:true,force:true});}
});
