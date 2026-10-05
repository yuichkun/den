import assert from 'node:assert/strict';
import {compile} from '@unworklet/core';
import processor from './freeze-processor.ts';
import {createHash} from 'node:crypto';
import {writeFileSync,readFileSync} from 'node:fs';
const reports=[];
for(const sampleRate of [44100,48000,96000]){
 const compiled=await compile(processor,{sampleRate}),memory=compiled.memory,regions=memory.regions;
 const slots=[...Object.entries(regions.states.slots).filter(([name])=>!name.endsWith('/wetScaled')).map(([name,offset])=>({name,offset,bytes:name.endsWith('/phase')?8:4})),...Object.entries(regions.buffers.slots).map(([name,offset])=>({name,offset,bytes:regions.buffers.lengths[name]*8}))];
 const capture=d=>slots.map(s=>({...s,data:Uint8Array.from(new Uint8Array(d.memory.buffer,s.offset,s.bytes))}));
 const restore=(d,snapshot)=>{for(const s of snapshot)new Uint8Array(d.memory.buffer,s.offset,s.bytes).set(s.data);};
 const controls=(d,values)=>{for(const[key,value]of Object.entries(values))d.writeParam(key,new Float32Array(128).fill(value));};
 const process=(d,blocks)=>{const out=Array.from({length:8},()=>new Float32Array(blocks*128));for(let b=0;b<blocks;b++){d.process();for(let ch=0;ch<8;ch++){const x=new Float32Array(128);d.readOutput('main',ch,x);out[ch].set(x,b*128);}}assert.equal(d.scrubbedSamples(),0);assert(out.every(c=>c.every(Number.isFinite)));return out;};
 const peak=x=>x.reduce((m,v)=>Math.max(m,Math.abs(v)),0),paired=out=>[peak(out[6]),peak(out[7])];
 const savedControls={level:0,disturb:1,freeze:1,reset:0},mutatedControls={level:0,disturb:1,freeze:0,reset:0};
 const original=await compiled.driver.instantiate();controls(original,{level:.15,disturb:0,freeze:0,reset:0});process(original,100);controls(original,{level:0,disturb:0,freeze:1,reset:0});process(original,75);controls(original,savedControls);const blocked=process(original,75);assert.deepEqual(paired(blocked),[0,0]);const snapshot=capture(original);
 // Mirrors worklet applyRestoreSlots: copy persistent states and buffers only.
 // Deliberately preserve transient wet taps, all host parameter values and IO.
 const makeMutated=async()=>{const d=await compiled.driver.instantiate();restore(d,snapshot);controls(d,{level:0,disturb:0,freeze:0,reset:0});process(d,300);controls(d,{reset:1});process(d,50);controls(d,mutatedControls);const out=process(d,75);assert(peak(out[6])>1e-5);return d;};
 const cold=await compiled.driver.instantiate();restore(cold,snapshot);controls(cold,savedControls);const coldOut=process(cold,75);
 assert.deepEqual(paired(coldOut),[0,0]);
 const safe=await makeMutated();controls(safe,savedControls);process(safe,2);restore(safe,snapshot);
 for(const[name,offset]of Object.entries(regions.states.slots))if(name.endsWith('/wetScaled'))new DataView(safe.memory.buffer).setFloat64(offset,name.startsWith('a/')?1e90:-1e90,true);
 const safeOut=process(safe,75);assert.deepEqual(safeOut,coldOut);assert.deepEqual(paired(safeOut),[0,0]);
 const unsafe=[];
 for(const staleBlocks of [1,2,4,8,32]){
  const d=await makeMutated();restore(d,snapshot);const gap=process(d,staleBlocks);controls(d,savedControls);const settled=process(d,75);assert(settled[4].slice(128).every(x=>x===1));assert(settled[5].slice(128).every(x=>x===1));const last=settled.map(ch=>ch.slice(-4096));const residual=paired(last);assert(residual.some(x=>x>1e-5));if(sampleRate===48000&&staleBlocks===1)assert.equal(residual[0],0.2498931884765625,'retained hosted one-quantum control-race residual');
  unsafe.push({staleBlocks,firstProgress:Array.from(gap[4].slice(0,20)),last4096PairedPeak:residual,allSettledPairedPeak:paired(settled),wetPeak:[peak(last[0]),peak(last[1])]});
 }
 reports.push({sampleRate,persistentSlots:slots.length,snapshotBytes:slots.reduce((n,s)=>n+s.bytes,0),safeAndColdBitIdentical:true,safePairedPeak:paired(safeOut),safeTransientPoisonRecomputed:true,unsafe,wasmSha256:createHash('sha256').update(compiled.wasm).digest('hex')});
}
// This fixture intentionally mirrors native persistent-slot overlay only.
// It is a deterministic regression, not a production restore implementation.
const report={status:'DIAGNOSIS ONLY / CANDIDATE NOT_CLEARED',sourceProcessorSha256:createHash('sha256').update(readFileSync('freeze-processor.ts')).digest('hex'),method:'Actual native compiled driver; reproduce persistent byte-copy restore order from pinned core 0.4.1; host parameter gap simulated deterministically in processing blocks; no production changes.',conclusion:'Live core restore is not atomic with host AudioParam restoration. Paired freeze histories diverge after any tested stale live-control gap; synchronizing saved controls before persistent restore preserves exact equality and matches fresh native restore despite poisoned transient taps.',reports};writeFileSync('freeze-live-restore-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
