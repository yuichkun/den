import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {compile,inspect,wireToMidiEvent} from '@unworklet/core';
import {renderOffline} from '@unworklet/offline';
import {makeProcessor} from './processor.ts';
const on=(note,ch=1,velocity=127)=>[0x90+ch,note,velocity];
const off=(note,ch=1)=>[0x80+ch,note,0];
const cc=(controller,value=0,ch=1)=>[0xb0+ch,controller,value];
const pressure=(value,ch=1)=>[0xd0+ch,value,0];
const bend=(value,ch=1)=>[0xe0+ch,value&127,value>>7];
const events=steps=>steps.flatMap((step,q)=>step.map(bytes=>({name:'midi',payload:wireToMidiEvent(...bytes),atSample:q*128})));
const reports=[];
for(const sampleRate of [44100,48000,96000]){
  const processor=makeProcessor(),frames=1024;
  const result=await renderOffline(processor,{sampleRate,duration:(frames-.25)/sampleRate,
    events:events([
      [on(69),pressure(127,1),cc(74,127,1),pressure(127,0),cc(74,127,0)],
      [bend(16383,1),bend(16383,0)],
      [bend(0,2),on(81,2),pressure(127,2),cc(74,127,2)],
      [cc(64,127,1),off(69,1),pressure(0,1),cc(74,0,1)],
      [bend(0,0),cc(64,0,1)],[],[cc(120,0,2)],[],
    ]),params:{release:[256/sampleRate],gain:[.2]}});
  assert.equal(result.diagnostics.scrubbedSamples,0);
  const phase=[0,0];let maxFrequencyError=0,maxLevelError=0,maxAudioError=0;
  for(let n=0;n<frames;n++){
    const hz=[n<128?440:n<512?Math.fround(440*2**(50/12)):n<768?Math.fround(440*2**(46/12)):0,n>=256&&n<768?Math.fround(880*2**((n<512?-46:-50)/12)):0];
    const level=[n<384?1:n<512?.5625:n<768?.5625*(767-n)/256:0,n>=256&&n<768?1:0];
    let expected=0;
    for(let slot=0;slot<2;slot++){
      if(n===0||slot===1&&n===256)phase[slot]=0;
      expected+=Math.sin(2*Math.PI*phase[slot])*level[slot]*.2;
      maxFrequencyError=Math.max(maxFrequencyError,Math.abs(result.outputs.frequency[slot][n]-hz[slot]));
      maxLevelError=Math.max(maxLevelError,Math.abs(result.outputs.level[slot][n]-level[slot]));
      phase[slot]=(phase[slot]+hz[slot]/sampleRate)%1;
    }
    maxAudioError=Math.max(maxAudioError,Math.abs(result.outputs.main[0][n]-expected));
  }
  assert(maxFrequencyError<.001,`frequency ${maxFrequencyError}`);assert(maxLevelError<2e-7,`level ${maxLevelError}`);assert(maxAudioError<3e-6,`audio ${maxAudioError}`);
  // All four declared allocator slots and the highest member channel. No reuse
  // of performancePolicy.bend in pitch: +48 member +2 master must give +50.
  const notes=[45,57,64,69],channels=[1,2,3,15];
  const chord=await renderOffline(processor,{sampleRate,duration:(128-.25)/sampleRate,events:events([[
    bend(16383,0),pressure(127,0),cc(74,127,0),...channels.flatMap((ch,n)=>[bend(16383,ch),pressure(127,ch),cc(74,127,ch),on(notes[n],ch)]),
  ]])});
  let maxChordError=0;
  for(let n=0;n<128;n++){
    let expected=0;
    for(let slot=0;slot<4;slot++){
      const hz=Math.fround(440*2**((notes[slot]+50-69)/12));
      assert(Math.abs(chord.outputs.frequency[slot][n]-hz)<.001);assert.equal(chord.outputs.level[slot][n],1);
      expected+=Math.sin(2*Math.PI*hz*n/sampleRate)*.2;
    }
    maxChordError=Math.max(maxChordError,Math.abs(chord.outputs.main[0][n]-expected));
  }
  assert(maxChordError<3e-6,`chord ${maxChordError}`);assert.equal(chord.diagnostics.scrubbedSamples,0);
  const slots=Object.keys(inspect(result.state).slots);assert(!slots.some(k=>k.includes('performance')||k.includes('expression')));assert(slots.some(k=>k.includes('amp0')));
  const held=await renderOffline(processor,{sampleRate,duration:(256-.25)/sampleRate,events:events([[on(69),cc(64,127),off(69),bend(0,1),pressure(127,1)]])});
  const restored=await renderOffline(processor,{sampleRate,duration:(256-.25)/sampleRate,restore:held.state});
  assert(restored.outputs.main[0].every(x=>x===0));assert.equal(restored.diagnostics.scrubbedSamples,0);
  const fresh=await renderOffline(processor,{sampleRate,duration:(256-.25)/sampleRate,restore:held.state,events:events([[on(69),pressure(127,1),cc(74,127,1)]])});
  assert.equal(fresh.outputs.main[0][0],0);assert.equal(fresh.outputs.main[0][1],0);assert(fresh.outputs.main[0].slice(2).some(x=>Math.abs(x)>.01));assert(fresh.outputs.frequency[0].every(x=>x===440));
  const panic=await renderOffline(processor,{sampleRate,duration:(256-.25)/sampleRate,events:events([[on(69),bend(0,1)]]),messages:[{name:'reset',payload:{value:1},atQuantum:1}]});
  assert(panic.outputs.main[0].slice(128).every(x=>x===0));
  reports.push({sampleRate,frames,maxFrequencyError,maxLevelError,maxAudioError,maxChordError,restoredHeldNotes:0,scrubbedSamples:0,memberChannels:15,voices:4});
}
const compiled=await compile(makeProcessor(),{sampleRate:48000}),instance=await compiled.driver.instantiate(),memoryBytes=instance.memory.buffer.byteLength;
for(let n=0;n<256;n++)instance.process();assert.equal(instance.memory.buffer.byteLength,memoryBytes);assert.equal(instance.scrubbedSamples(),0);
writeFileSync('mpe-expression-results.json',JSON.stringify({status:'CANDIDATE',reports,compiled:{wasmBytes:compiled.wasm.byteLength,memoryBytes,blocks:256},limitations:['Expression-only lower zone; not full MPE','No master-pedal propagation','Channel-shared release tails','No hardware/browser real-time clearance','Native quantum FIFO','Not human approved']},null,2));
console.log(JSON.stringify({reports,wasmBytes:compiled.wasm.byteLength,memoryBytes}));
