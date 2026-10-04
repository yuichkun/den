import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { renderOffline, encodeWav } from '@unworklet/offline';
import { audition } from './audition-processor.js';
const sampleRate=48000,length=33792,onSamples=16800;
const gate=Float32Array.from({length},(_,i)=>i<onSamples?1:0);
const params={gate,frequency:[220],attack:[0.04],decay:[0.2],sustain:[0.65],release:[0.2],depth:[0],rate:[4]};
const result=await renderOffline(audition,{sampleRate,duration:(length-.5)/sampleRate,params});
assert.equal(result.diagnostics.scrubbedSamples,0);
const raw=result.outputs.main[0];assert.equal(raw.length,length);
const sustain=Math.fround(.65);let error=0;
for(let i=0;i<length;i++){
  const level=i<1920?(i+1)/1920:i<11520?1-(1-sustain)*(i-1919)/9600:i<onSamples?sustain:i<onSamples+9600?sustain*(1-(i-onSamples+1)/9600):0;
  error=Math.max(error,Math.abs(raw[i]-Math.sin(2*Math.PI*220*i/sampleRate)*level));
}
assert(error<2e-6,`independent sine × envelope error ${error}`);
assert(raw.slice(onSamples+9600).every(x=>x===0),'tail must be exactly silent');
const audible=Float32Array.from(raw,x=>x*.035);
const wav=encodeWav([audible],sampleRate);writeFileSync('candidate-audition.wav',wav);
writeFileSync('candidate-audition.json',JSON.stringify({status:'CANDIDATE — not listening-approved',sampleRate,samples:length,settings:{...params,gate:{onSamples},outputGain:.035},maxError:error,sha256:createHash('sha256').update(wav).digest('hex')},null,2));
console.log(`Packed audition sine × envelope max error ${error}; release silence verified`);

// The same independent pitch oracle must distinguish real depth from a disconnected LFO.
const {assertPitchModulation}=await import('./pitch-oracle.mjs');
const heldParams={gate:[1],frequency:[220],attack:[.005],decay:[.005],sustain:[.65],rate:[4]};
const modulated=await renderOffline(audition,{sampleRate,duration:2.048,params:{...heldParams,depth:[.5]}});
const unmodulated=await renderOffline(audition,{sampleRate,duration:2.048,params:{...heldParams,depth:[0]}});
const pitchModulation=assertPitchModulation(modulated.outputs.main[0].slice(48000));
assert.throws(()=>assertPitchModulation(unmodulated.outputs.main[0].slice(48000)),/pitch modulation depth/);
writeFileSync('candidate-pitch.json',JSON.stringify({pitchModulation,zeroDepthRejected:true},null,2));
console.log('Nonzero LFO depth/rate verified; zero-depth counterexample rejected',pitchModulation);
