import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildConsumer} from '../../scripts/build-consumer.mjs';
import {captureRealtime} from './capture.mjs';

function assertNoUnderruns(r){
 assert(r.observationComplete,`${r.mode}: playback statistics did not cover capture within four seconds`);
 assert(r.before&&r.settled,'Chromium AudioContext.playbackStats is required; offline capture alone misses underruns');
 assert.equal(r.settled.underrunEvents-r.before.underrunEvents,0,`${r.mode}: real-time underrun events`);
 assert.equal(r.settled.underrunDuration-r.before.underrunDuration,0,`${r.mode}: real-time underrun duration`);
}

test('sustained packed audition meets real-time deadlines and preserves raw continuity',{timeout:240000},async()=>{
 const root=join(import.meta.dirname,'../..'),artifacts=join(root,'artifacts/realtime/current');
 // Own only this run directory; a failed run must never present an older manifest.
 rmSync(artifacts,{recursive:true,force:true});mkdirSync(artifacts,{recursive:true});
 const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
 const provenance={sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='',sources:Object.fromEntries(['tests/consumer/audition-processor.js','tests/realtime/capture.mjs','tests/realtime/audition.test.mjs','src/envelope.ts','src/lfo.ts','src/oscillator.ts','package-lock.json'].map(file=>[file,hash(join(root,file))]))};
 let consumer,cost=null,failure=null,completed=false;
 const json=file=>existsSync(join(artifacts,file))?JSON.parse(readFileSync(join(artifacts,file),'utf8')):null;
 const persist=()=>{
  const results=json('probe.json')??[];
  writeFileSync(join(artifacts,'manifest.json'),JSON.stringify({status:'CANDIDATE — not listening-approved',verification:failure?'failed':completed?'passed':'running',...provenance,browser:json('environment.json'),sampleRate:48000,cost,results,error:failure,captureError:json('capture-error.json'),files:Object.fromEntries(results.map(r=>[r.mode+'.f32',hash(join(artifacts,r.mode+'.f32'))])),limitations:['Chromium headless; no physical mobile listening','Raw capture precedes hardware fallback; playbackStats checks that separate layer','One-second recorder warmup precedes each five-second steady window','Underrun interval conservatively includes delayed reporting and post-capture observation']},null,2));
 };
 persist();
 try {
  const built=buildConsumer({stageSite:false});consumer=built.consumer;
  const results=await captureRealtime(built.output,artifacts);
  persist(); // Preserve every completed capture before the first assertion.

  for(const r of results){
   assert(r.observationComplete,`${r.mode}: playback statistics observation timed out`);
   // Native oscillator is an environment control, not den's numerical contract.
   // Preserve its stats even if the runner itself stalls during that window.
   if(r.mode==='native-sine')continue;
   assertNoUnderruns(r);
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
  cost={wasmBytes:c.wasm.length,p50:durations[500],p95:durations[950],p99:durations[990],max:durations.at(-1),budgetMs:128/48};
  assert(cost.p95<cost.budgetMs/2,'DSP lacks 50% deadline headroom on this runner');
  completed=true;
  console.log(cost);
 }catch(error){failure={message:String(error),stack:error?.stack};throw error;}
 finally{try{persist();}finally{if(consumer)rmSync(consumer,{recursive:true,force:true});}}
});

// Counterexample exercises the same observation and zero-underrun assertion.
test('late playback statistics expose a final-quantum stall',{timeout:90000},async()=>{
 const root=join(import.meta.dirname,'../..'),artifacts=join(root,'artifacts/realtime/final-quantum-stall');
 rmSync(artifacts,{recursive:true,force:true});mkdirSync(artifacts,{recursive:true});
 const evidence={status:'FAULT INJECTION — not candidate audio',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='',sourceHashes:Object.fromEntries(['tests/realtime/capture.mjs','tests/realtime/audition.test.mjs'].map(file=>[file,createHash('sha256').update(readFileSync(join(root,file))).digest('hex')])),finalQuantumStallMs:100,error:null};
 let consumer;
 const persistFault=()=>writeFileSync(join(artifacts,'manifest.json'),JSON.stringify({...evidence,browser:existsSync(join(artifacts,'environment.json'))?JSON.parse(readFileSync(join(artifacts,'environment.json'),'utf8')):null,files:existsSync(join(artifacts,'native-sine.f32'))?{'native-sine.f32':createHash('sha256').update(readFileSync(join(artifacts,'native-sine.f32'))).digest('hex')}:{},captureError:existsSync(join(artifacts,'capture-error.json'))?JSON.parse(readFileSync(join(artifacts,'capture-error.json'),'utf8')):null},null,2));
 persistFault();
 try{
  const built=buildConsumer({stageSite:false});consumer=built.consumer;
  const [r]=await captureRealtime(built.output,artifacts,{modes:['native-sine'],finalQuantumStallMs:100});
  evidence.result=r;persistFault();
  assert(r.observationComplete,'fault observation timed out');
  assert(r.settled.underrunEvents>r.before.underrunEvents,'injected 100 ms stall was not reported');
  assert.throws(()=>assertNoUnderruns(r),/real-time underrun events/);
 }catch(error){evidence.error=String(error);throw error;}
 finally{
  persistFault();
  if(consumer)rmSync(consumer,{recursive:true,force:true});
 }
});
