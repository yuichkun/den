import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { renderOffline, encodeWav } from '@unworklet/offline';
import { createInstrument, diagnosticInstrumentParameters } from '@denaudio/den/instrument';
import { replacementInstrument } from './node_modules/@denaudio/den/dist/instrument-example.js';
const settings = {mode:'poly',capacity:4,heldCapacity:32,waveform:'sine'};
const parameters = {...diagnosticInstrumentParameters};
const midi = [
  {name:'midi',atSample:0,payload:{type:'noteOn',note:60,velocity:90,channel:0}},
  ...[64,67].map(note=>({name:'midi',atSample:4096,payload:{type:'noteOn',note,velocity:75,channel:0}})),
  {name:'midi',atSample:16384,payload:{type:'noteOff',note:60,velocity:0,channel:0}},
  ...[64,67].map(note=>({name:'midi',atSample:24576,payload:{type:'noteOff',note,velocity:0,channel:0}})),
];
const measurements = [];
for (const sampleRate of [44100,48000,96000]) {
  const result = await renderOffline(createInstrument(settings), {sampleRate,duration:65536/sampleRate,
    params:Object.fromEntries(Object.entries(parameters).map(([k,v])=>[k,[v]])),events:midi});
  assert.equal(result.outputs.main[0].length,65536);
  assert.equal(result.diagnostics.scrubbedSamples,0);
  assert.deepEqual(result.outputs.main[0],result.outputs.main[1]);
  const audio=result.outputs.main[0];
  assert(audio.every(Number.isFinite));
  const peak=audio.reduce((p,x)=>Math.max(p,Math.abs(x)),0);
  assert(peak>0.03&&peak<1);
  assert(audio.slice(49152).every(x=>x===0));
  writeFileSync(`instrument-${sampleRate}.wav`,encodeWav(result.outputs.main,sampleRate));
  const points=Array.from({length:1024},(_,i)=>{const chunk=audio.subarray(i*64,i*64+64);return `${40+i},${150-100*chunk.reduce((p,x)=>Math.abs(x)>Math.abs(p)?x:p,0)}`;}).join(' ');
  writeFileSync(`instrument-${sampleRate}.svg`,`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 300"><title>CANDIDATE diagnostic instrument ${sampleRate} Hz</title><text x="40" y="25">CANDIDATE ${sampleRate} Hz; 65536 frames; amplitude scale ±1</text><path d="M40 50V250H1064M40 150H1064" fill="none" stroke="gray"/><polyline points="${points}" fill="none" stroke="blue"/></svg>`);
  measurements.push({sampleRate,frames:audio.length,peak,scrubbedSamples:result.diagnostics.scrubbedSamples,endedSilently:true});
}
const replaced=await renderOffline(replacementInstrument,{sampleRate:48000,duration:256/48000,events:[midi[0]]});
assert(replaced.outputs.main[0].some(x=>Math.abs(x)>1e-6));
assert.equal(replaced.diagnostics.scrubbedSamples,0);
writeFileSync('instrument-evidence.json',JSON.stringify({settings,parameters,midi,measurements,seed:null,input:null,status:'CANDIDATE'},null,2));
