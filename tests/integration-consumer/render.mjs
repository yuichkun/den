import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {renderOffline,encodeWav} from '@unworklet/offline';
import {instrument} from './instrument.js';
import {delay} from './delay.js';
import {instrumentInitial,engineConfig,masterMaximum,feedbackMaximum} from './settings.js';
import {lowpass,delayReference,compare,peak} from './reference.mjs';
const sampleRate=48000,frames=147456,offAt=73728,notesCases=[[60,64,67,72],[69,69,69,69]],measurements=[];
const params=Object.fromEntries(Object.entries(instrumentInitial).map(([k,v])=>[k,[v]]));
let candidate;
for(const notes of notesCases){
 const events=notes.flatMap(note=>[{name:'midi',atSample:0,payload:{type:'noteOn',note,velocity:127,channel:0}},{name:'midi',atSample:offAt,payload:{type:'noteOff',note,velocity:0,channel:0}}]);
 const source=await renderOffline(instrument,{sampleRate,duration:frames/sampleRate,params,events});
 assert.equal(source.diagnostics.scrubbedSamples,0);assert.deepEqual(source.outputs.main[0],source.outputs.main[1]);
 const expected=new Float64Array(frames);
 for(const note of notes){const filter=lowpass(sampleRate),hz=Math.fround(440*2**((note-69)/12));for(let n=0;n<frames;n++){const envelope=n<480?(n+1)/480:n<offAt?1:Math.max(0,1-(n-offAt+1)/9600);expected[n]+=.05*envelope*filter(Math.sin(2*Math.PI*hz*n/sampleRate));}}
 const sourceError=compare(source.outputs.main[0],expected);
 for(const mix of [0,.35,1]){
  const fxParams={timeLeft:[.125],timeRight:[.1875],feedback:[feedbackMaximum],mix:[mix]};
  const fx=await renderOffline(delay,{sampleRate,duration:frames/sampleRate,inputs:{main:source.outputs.main},params:fxParams});assert.equal(fx.diagnostics.scrubbedSamples,0);
  const error=fx.outputs.main.map((v,ch)=>compare(v,delayReference(source.outputs.main[ch],sampleRate,ch?.1875:.125,feedbackMaximum,mix)));
  const output=fx.outputs.main.map(v=>Float32Array.from(v,x=>x*masterMaximum));const peaks=output.map(peak);
  // Fixed Q=.5 / cutoff1k: nonnegative low-pass response, at most four .05 voices.
  // Feedback<=.5 gives .2/(1-.5)=.4 before Master<=.1, hence .04 peak.
  assert(peaks.every(p=>p<=.040001),'absolute peak bound exceeded');assert(peaks.some(p=>p>.001));
  measurements.push({notes,velocity:127,feedback:feedbackMaximum,mix,master:masterMaximum,sourceError,error,peaks});
  if(mix===.35&&notes[0]===60)candidate=output;
 }
}
const wav=encodeWav(candidate,sampleRate);writeFileSync('integration-candidate.wav',wav);writeFileSync('integration-numerical.json',JSON.stringify({status:'CANDIDATE',runtimeGate:'NOT_CLEARED',listening:'UNVERIFIED',sampleRate,frames,offAt,engineConfig,instrumentInitial,measurements,wavSha256:createHash('sha256').update(wav).digest('hex')},null,2));console.log(JSON.stringify(measurements));
