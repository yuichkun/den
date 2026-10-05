import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { compile, inspect } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { makeProcessor } from './processor.ts';
const on=(note,velocity=127,channel=0)=>({type:'noteOn',note,velocity,channel});
const off=(note,channel=0)=>({type:'noteOff',note,velocity:0,channel});
const cc=(controller,value=0,channel=0)=>({type:'cc',controller,value,channel});
const pressure=(pressure,channel=0)=>({type:'channelPressure',pressure,channel});
const bend=(value,channel=0)=>({type:'pitchBend',value,channel});
const events=steps=>steps.flatMap((step,q)=>step.map(payload=>({name:'midi',payload,atSample:q*128})));
const reports=[];
for(const sampleRate of [44100,48000,96000]){
  const processor=makeProcessor(),frames=1280;
  const midi=events([
    [on(69),pressure(127),cc(74,127)],[],[cc(64,127),off(69)],[bend(16383)],
    [cc(64,0)],[],[],[on(81,127,1),pressure(127,1),cc(74,127,1)],
    [cc(120,0,1)],[],
  ]);
  const result=await renderOffline(processor,{sampleRate,duration:(frames-.25)/sampleRate,events:midi,params:{release:[256/sampleRate],gain:[.2]}});
  assert.equal(result.diagnostics.scrubbedSamples,0);
  // Only slot zero is used here. MIDI bend persists during the release.
  let phase=0,maxAudioError=0,maxFrequencyError=0,maxLevelError=0;
  for(let n=0;n<frames;n++){
    const active=n<768||n>=896&&n<1024,frequency=n<384?440:n<768?Math.fround(440*2**(2/12)):n>=896&&n<1024?880:0;
    const level=n<512?1:n<768?(767-n)/256:n>=896&&n<1024?1:0;
    if(n===0||n===896)phase=0;
    const expected=active?Math.sin(2*Math.PI*phase)*level*.2:0;
    maxAudioError=Math.max(maxAudioError,Math.abs(result.outputs.main[0][n]-expected));
    maxFrequencyError=Math.max(maxFrequencyError,Math.abs(result.outputs.frequency[0][n]-frequency));
    maxLevelError=Math.max(maxLevelError,Math.abs(result.outputs.level[0][n]-level));
    phase=(phase+frequency/sampleRate)%1;
  }
  assert(maxAudioError<3e-6,`audio ${maxAudioError}`);assert(maxFrequencyError<.001,`frequency ${maxFrequencyError}`);assert(maxLevelError<2e-7,`level ${maxLevelError}`);
  const chordNotes=[69,72,76,81];
  const chord=await renderOffline(processor,{sampleRate,duration:(128-.25)/sampleRate,events:events([[...chordNotes.map(note=>on(note)),pressure(127),cc(74,127)]])});
  let maxChordError=0;
  for(let n=0;n<128;n++){
    const expected=.2*chordNotes.reduce((sum,note)=>sum+Math.sin(2*Math.PI*Math.fround(440*2**((note-69)/12))*n/sampleRate),0);
    maxChordError=Math.max(maxChordError,Math.abs(chord.outputs.main[0][n]-expected));
    assert(chord.outputs.level.every(c=>c[n]===1));
  }
  assert(maxChordError<2e-6,`chord ${maxChordError}`);assert.equal(chord.diagnostics.scrubbedSamples,0);
  const slots=Object.keys(inspect(result.state).slots);
  assert(slots.some(k=>k.includes('amp0')));assert(!slots.some(k=>k.includes('performance')));
  // Persistent envelopes/oscillators are safe when live identities restore empty.
  const held=await renderOffline(processor,{sampleRate,duration:(256-.25)/sampleRate,events:events([[on(69),cc(64,127),off(69)]])});
  const resumed=await renderOffline(processor,{sampleRate,duration:(256-.25)/sampleRate,restore:held.state});
  assert(resumed.outputs.main[0].every(x=>x===0));assert.equal(resumed.diagnostics.scrubbedSamples,0);
  const fresh=await renderOffline(processor,{sampleRate,duration:(256-.25)/sampleRate,restore:held.state,events:events([[on(69),pressure(127),cc(74,127)]])});
  assert.equal(fresh.outputs.main[0][0],0);assert.equal(fresh.outputs.main[0][1],0);assert(fresh.outputs.main[0].slice(2).some(x=>Math.abs(x)>.01));
  // Native parameter automation reaches the tuning converter without a new API.
  const tuning=await renderOffline(makeProcessor({mode:'mono',heldCapacity:4}),{sampleRate,duration:(256-.25)/sampleRate,events:events([[on(69)]]),params:{transpose:Array.from({length:256},(_,n)=>12*n/255),a4:[432],cents:[25]}});
  let maxAutomationError=0;for(let n=0;n<256;n++)maxAutomationError=Math.max(maxAutomationError,Math.abs(tuning.outputs.frequency[0][n]-Math.fround(432*2**((Math.fround(12*n/255)+.25)/12))));
  assert(maxAutomationError<.0002,`automation ${maxAutomationError}`);assert.equal(tuning.diagnostics.scrubbedSamples,0);
  reports.push({sampleRate,frames,maxAudioError,maxChordError,maxFrequencyError,maxLevelError,maxAutomationError,snapshotSlots:slots.length,scrubbedSamples:0,restoredHeldNotes:0,capacity:4,heldCapacity:8});
}
const compiled=await compile(makeProcessor(),{sampleRate:48000}),instance=await compiled.driver.instantiate();
const memoryBytes=instance.memory.buffer.byteLength;for(let n=0;n<256;n++)instance.process();
assert.equal(instance.memory.buffer.byteLength,memoryBytes);assert.equal(instance.scrubbedSamples(),0);
writeFileSync('performance-results.json',JSON.stringify({status:'CANDIDATE',reports,compiled:{wasmBytes:compiled.wasm.byteLength,memoryBytes,blocks:256},limitations:['No MPE','No browser/hardware real-time acceptance','No human-approved sound','MIDI quantum-boundary FIFO']},null,2));
console.log(JSON.stringify({reports,wasmBytes:compiled.wasm.byteLength,memoryBytes}));
