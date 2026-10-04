import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {renderOffline,encodeWav} from '@unworklet/offline';
import {instrument} from './instrument.js';
import {delay} from './delay.js';
import {chorus} from './chorus.js';
import {rhythmic} from './rhythmic.js';
import {chorusSettings,rhythmicDelaySettings} from '@denaudio/den/delay-settings';
import {inputs,reference} from './delay-settings-reference.mjs';
import {instrumentInitial,engineConfig,masterMaximum,feedbackMaximum} from './settings.js';
import {lowpass,delayReference,compare,peak} from './reference.mjs';
const sampleRate=48000,frames=147456,offAt=73728,notesCases=[[60,64,67,72],[69,69,69,69]],measurements=[];
const params=Object.fromEntries(Object.entries(instrumentInitial).map(([k,v])=>[k,[v]]));
let candidate;const sources=[];
for(const notes of notesCases){
 const events=notes.flatMap(note=>[{name:'midi',atSample:0,payload:{type:'noteOn',note,velocity:127,channel:0}},{name:'midi',atSample:offAt,payload:{type:'noteOff',note,velocity:0,channel:0}}]);
 const source=await renderOffline(instrument,{sampleRate,duration:frames/sampleRate,params,events});
 assert.equal(source.diagnostics.scrubbedSamples,0);assert.deepEqual(source.outputs.main[0],source.outputs.main[1]);
 const expected=new Float64Array(frames);
 for(const note of notes){const filter=lowpass(sampleRate),hz=Math.fround(440*2**((note-69)/12));for(let n=0;n<frames;n++){const envelope=n<480?(n+1)/480:n<offAt?1:Math.max(0,1-(n-offAt+1)/9600);expected[n]+=.05*envelope*filter(Math.sin(2*Math.PI*hz*n/sampleRate));}}
 const sourceError=compare(source.outputs.main[0],expected);sources.push({notes,source});
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

const settingMeasurements=[];
for(const [name,processor,setting] of [['chorus',chorus,chorusSettings],['rhythmic',rhythmic,rhythmicDelaySettings]]){
 for(const {notes,source} of sources){
  for(const maximum of [false,true]){
   const parameters={...setting.parameters,...(maximum?{feedback:feedbackMaximum,mix:1}:{})};
   const fx=await renderOffline(processor,{sampleRate,duration:frames/sampleRate,inputs:{main:source.outputs.main},params:{feedback:[parameters.feedback],mix:[parameters.mix]}});
   assert.equal(fx.diagnostics.scrubbedSamples,0);
   const data=inputs(sampleRate,Object.fromEntries(Object.entries(parameters).map(([k,v])=>[k,Number(v)])),frames,n=>source.outputs.main[0][n],n=>source.outputs.main[1][n]);
   const expected=reference(sampleRate,setting.config,data);
   assert(expected[2].every(v=>v===0)&&expected[3].every(v=>v===0));
   const errors=fx.outputs.main.map((v,ch)=>compare(v,expected[ch],5e-6));
   const output=fx.outputs.main.map(v=>Float32Array.from(v,x=>x*masterMaximum));const peaks=output.map(peak);
   assert(peaks.every(p=>p<=.040001));assert(peaks.some(p=>p>.001));
   const row={name,notes,maximum,parameters,config:setting.config,errors,peaks};
   if(!maximum&&notes[0]===60){const wav=encodeWav(output,sampleRate);writeFileSync('integration-'+name+'.wav',wav);row.wavSha256=createHash('sha256').update(wav).digest('hex');}
   settingMeasurements.push(row);
  }
 }
}
writeFileSync('integration-settings-numerical.json',JSON.stringify({status:'CANDIDATE',runtimeGate:'NOT_CLEARED',listening:'UNVERIFIED',sampleRate,frames,settingMeasurements},null,2));
console.log(JSON.stringify(settingMeasurements));
