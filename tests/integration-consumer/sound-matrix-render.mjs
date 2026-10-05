// CANDIDATE evidence only. Run inside the isolated, npm-packed consumer.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {renderOffline,encodeWav} from '@unworklet/offline';
import {createInstrument} from '@denaudio/den/instrument';
import {instrumentCandidates,delayCandidates,masterDefault,masterMaximum,feedbackMaximum} from './settings.js';
import {delay} from './delay.js';
import {chorus} from './chorus.js';
import {rhythmic} from './rhythmic.js';

const sampleRate=48000,quantum=128;
const frame=seconds=>Math.ceil(seconds*sampleRate/quantum)*quantum;
const nativeParams=parameters=>Object.fromEntries(Object.entries(parameters).map(([key,value])=>[key,[value]]));
const hash=data=>createHash('sha256').update(data).digest('hex');
const processors={diagnostic:delay,chorus,rhythmic};
// Explicit numerical regression ceilings, independently selected from the raw
// gains and voice limits, NOT golden PCM or a universal arbitrary-MIDI proof.
// Bass permits 2x its .12 raw gain for resonant/transient overshoot. The other
// ceilings add small rounding margin to voice-count * gain (Q=.5). Every actual
// source must pass these ceilings before the feedback-derived FX bound is used.
const sourceCeilings={diagnostic:.20001,bass:.24,percussion:.16001,pad:.18001};
const maximumOutputCeiling=.5; // >= 6.02 dB measured/derived margin to full scale.
assert.equal(masterDefault,1);assert(masterMaximum>=masterDefault&&masterMaximum<=1);
assert.equal(feedbackMaximum,.5);
assert.deepEqual(Object.keys(instrumentCandidates).sort(),['bass','diagnostic','pad','percussion']);
assert.deepEqual(Object.keys(delayCandidates).sort(),['chorus','diagnostic','rhythmic']);

function measure(audio,gain=1){
 let peak=0,sum=0,clippedSamples=0,nonfiniteSamples=0;
 for(const raw of audio){const value=raw*gain;if(!Number.isFinite(value))nonfiniteSamples++;peak=Math.max(peak,Math.abs(value));sum+=value*value;if(Math.abs(value)>=1)clippedSamples++;}
 return {frames:audio.length,peak,rms:Math.sqrt(sum/audio.length),headroomDb:peak>0?-20*Math.log10(peak):null,clippedSamples,nonfiniteSamples};
}
function valid(stats,ceiling){assert.equal(stats.nonfiniteSamples,0);assert.equal(stats.clippedSamples,0);assert(stats.peak>1e-5&&stats.peak<=ceiling,`peak ${stats.peak} exceeds ${ceiling}`);}
// Guards must fail loudly rather than accept clipped/scrubbed test material.
assert.throws(()=>valid(measure(Float32Array.of(1.1)),maximumOutputCeiling));
assert.throws(()=>valid(measure(Float32Array.of(NaN)),maximumOutputCeiling));
assert.throws(()=>valid(measure(Float32Array.of(.6)),maximumOutputCeiling));

function event(atSample,type,note){return {name:'midi',atSample,payload:{type,note,velocity:type==='noteOn'?127:0,channel:0}};}
function fixture(setting,groups,holdSeconds,{retrigger=false,legato=false}={}){
 const events=[],windows=[];let cursor=0;
 const release=frame(Math.fround(setting.parameters.ampRelease));
 for(const notes of groups){
  const start=cursor,off=start+frame(holdSeconds);
  events.push(...notes.map(note=>event(start,'noteOn',note)));
  events.push(...notes.map(note=>event(off,'noteOff',note)));
  let finalOff=off;
  if(retrigger){
   const again=off+quantum;finalOff=again+frame(.25);
   events.push(...notes.map(note=>event(again,'noteOn',note)),...notes.map(note=>event(finalOff,'noteOff',note)));
  }
  const silenceFrom=finalOff+release+quantum;
  // Include a full second of source silence between groups. FX history remains
  // live, so repeated input also stresses wet-tail accumulation.
  cursor=silenceFrom+frame(1);
  windows.push({notes,start,off,finalOff,silenceFrom,end:cursor,retrigger});
 }
 if(legato){
  const [first,second]=setting.notes,start=cursor,overlap=start+frame(.25),back=overlap+frame(.25),off=back+frame(.25);
  events.push(event(start,'noteOn',first),event(overlap,'noteOn',second),event(back,'noteOff',second),event(off,'noteOff',first));
  const silenceFrom=off+release+quantum;cursor=silenceFrom+frame(1);
  windows.push({notes:[first,second],start,off,finalOff:off,silenceFrom,end:cursor,legato:true});
 }
 // 12 longest-delay repeats after the source stops, at the maximum .5 feedback.
 const frames=cursor+frame(6);
 return {frames,events,windows};
}

// Independent oracle: unbounded write timelines and a direct-form bilinear
// low-pass, not the production ring buffers/SVF recurrence. This is specialized
// to the three static UI candidates and avoids a per-frame settings framework.
function reference(input,setting,parameters){
 const p=Object.fromEntries(Object.entries(parameters).map(([key,value])=>[key,typeof value==='number'?Math.fround(value):value]));
 const out=input.map(channel=>new Float32Array(channel.length));
 const maximum=setting.config.maxDelaySeconds,minimum=Math.fround(1/sampleRate);
 assert(p.feedback>=0&&p.feedback<=feedbackMaximum&&p.mix>=0&&p.mix<=1);
 assert(p.cutoffHz>0&&p.cutoffHz<sampleRate/4,'feedback low-pass must have a nonnegative impulse response');
 const base=p.sync?[Math.fround(60*p.beatsLeft/p.bpm),Math.fround(60*p.beatsRight/p.bpm)]:[p.timeLeftSeconds,p.timeRightSeconds];
 assert(base.every(t=>t>=minimum&&t<=maximum));
 const g=Math.tan(Math.PI*p.cutoffHz/sampleRate),norm=1/(1+2*g+g*g),b0=g*g*norm,a1=2*(g*g-1)*norm,a2=(1-2*g+g*g)*norm;
 for(let ch=0;ch<2;ch++){
  const written=new Float32Array(input[ch].length);let phase=ch===0?0:(setting.config.stereoPhaseCycles??.5)%1,x1=0,x2=0,y1=0,y2=0;
  for(let n=0;n<written.length;n++){
   const wave=Math.fround(Math.sin(2*Math.PI*phase));phase=(phase+p.rateHz/sampleRate)%1;
   const seconds=Math.fround(base[ch]+Math.fround(wave*p.depthSeconds));
   assert(seconds>=minimum&&seconds<=maximum,'candidate modulation must never clip');
   const position=n-Math.max(1,Math.min(maximum*sampleRate,seconds*sampleRate)),lower=Math.floor(position),fraction=position-lower;
   const wet=Math.fround((written[lower]??0)*(1-fraction)+(written[lower+1]??0)*fraction);
   const filtered=b0*(wet+2*x1+x2)-a1*y1-a2*y2;x2=x1;x1=wet;y2=y1;y1=filtered;
   const feedback=Math.fround((setting.config.tone==='flat'?wet:Math.fround(filtered))*p.feedback);
   written[n]=Math.fround(input[ch][n]+feedback);
   out[ch][n]=input[ch][n]*(1-p.mix)+wet*p.mix;
  }
 }
 return out;
}
function compare(actual,expected,tolerance=6e-6){
 let maximumError=0,worstFrame=0;assert.equal(actual.length,expected.length);
 for(let n=0;n<actual.length;n++){assert(Number.isFinite(actual[n]));const error=Math.abs(actual[n]-expected[n]);if(error>maximumError){maximumError=error;worstFrame=n;}}
 assert(maximumError<=tolerance,`FX reference error ${maximumError} at ${worstFrame}, tolerance ${tolerance}`);return {maximumError,worstFrame,tolerance};
}
function settings(name){
 const setting=delayCandidates[name];
 return name==='diagnostic'?{config:setting.config,parameters:{timeLeftSeconds:setting.parameters.timeLeft,timeRightSeconds:setting.parameters.timeRight,sync:false,bpm:120,beatsLeft:1,beatsRight:1,feedback:setting.parameters.feedback,cutoffHz:1000,mix:setting.parameters.mix,rateHz:0,depthSeconds:0,bypass:false,reset:false}}:setting;
}
const measurements=[],sourceMeasurements=[],candidates=[];
for(const [instrument,setting] of Object.entries(instrumentCandidates)){
 const processor=createInstrument(setting.config),p=setting.parameters;
 const period=p.lfoRate>0&&(p.lfoAmpDepth||p.lfoPitchDepth||p.lfoFilterDepth)?1/p.lfoRate:0;
 const longHold=Math.max(3,p.ampAttack+p.ampDecay+period+.1);
 const fixtures={
  'ui-register-retrigger':fixture(setting,setting.notes.map(note=>[note]),Math.max(.35,p.ampAttack+p.ampDecay+.1),{retrigger:true,legato:setting.config.mode==='mono'}),
  'ui-hold':fixture(setting,[setting.chord],longHold),
  ...(setting.config.mode==='poly'?{'coherent-four-register':fixture(setting,setting.notes.map(note=>Array(4).fill(note)),longHold)}:{}),
 };
 for(const [scenario,trace] of Object.entries(fixtures)){
  const result=await renderOffline(processor,{sampleRate,duration:(trace.frames-.5)/sampleRate,events:trace.events,params:nativeParams(p)}),audio=result.outputs.main;
  assert.equal(result.diagnostics.scrubbedSamples,0);assert.equal(audio.length,2);assert.equal(audio[0].length,trace.frames);assert.deepEqual(audio[0],audio[1]);
  const source=audio.map(channel=>measure(channel));source.forEach(stats=>valid(stats,sourceCeilings[instrument]));
  for(const window of trace.windows)assert(audio[0].subarray(window.silenceFrom,window.end).every(value=>value===0),'instrument release did not reach exact silence');
  if(period&&scenario!=='ui-register-retrigger')for(const window of trace.windows)assert((window.off-window.start)/sampleRate>=p.ampAttack+p.ampDecay+period,'full post-AD LFO period missing');
  const sourceRecord={instrument,scenario,config:setting.config,parameters:p,frames:trace.frames,seconds:trace.frames/sampleRate,velocity:127,lfoPeriodSeconds:period||null,sourceCeiling:sourceCeilings[instrument],source,events:trace.events,windows:trace.windows,scrubbedSamples:result.diagnostics.scrubbedSamples};
  sourceMeasurements.push(sourceRecord);
  for(const [effect,fxProcessor] of Object.entries(processors)){
   const settingFx=settings(effect);
   for(const [controls,override] of Object.entries({default:{},dry:{mix:0},maximum:{mix:1,feedback:feedbackMaximum}})){
    const parameters={...settingFx.parameters,...override};
    const fx=await renderOffline(fxProcessor,{sampleRate,duration:(trace.frames-.5)/sampleRate,inputs:{main:audio},params:nativeParams(effect==='diagnostic'?{...delayCandidates.diagnostic.parameters,feedback:parameters.feedback,mix:parameters.mix}:{feedback:parameters.feedback,mix:parameters.mix})});
    assert.equal(fx.diagnostics.scrubbedSamples,0);
    const expected=reference(audio,settingFx,parameters),errors=fx.outputs.main.map((channel,ch)=>compare(channel,expected[ch]));
    // For these static Q=.5 low-pass/flat feedback paths, the impulse-response
    // l1 norm is one and interpolated delay is non-expansive. Thus the measured
    // source supremum M gives M*((1-mix)+mix/(1-feedback)). This works with the
    // chorus's moving readheads too and is independent of the measured FX peak.
    const amplification=(1-parameters.mix)+parameters.mix/(1-parameters.feedback);
    const bounds=source.map(stats=>stats.peak*amplification*masterMaximum+1e-6);
    const fixedBound=sourceCeilings[instrument]*amplification*masterMaximum+1e-6;
    assert(fixedBound<=maximumOutputCeiling,'candidate controls exceed the explicit .5 output ceiling');
    const output=fx.outputs.main.map(channel=>measure(channel,masterMaximum));
    output.forEach((stats,ch)=>{valid(stats,maximumOutputCeiling);assert(stats.peak<=bounds[ch],`feedback bound exceeded: ${stats.peak} > ${bounds[ch]}`);});
    if(controls==='dry')fx.outputs.main.forEach((channel,ch)=>assert.deepEqual(channel,audio[ch]));
    const finalSilence=trace.windows.at(-1).silenceFrom;
    const releaseTail=fx.outputs.main.map(channel=>measure(channel.subarray(finalSilence),masterMaximum));
    const endTail=fx.outputs.main.map(channel=>measure(channel.subarray(channel.length-frame(.1)),masterMaximum));
    const row={instrument,effect,scenario,controls,parameters,masterDefault,masterMaximum,outputCeiling:maximumOutputCeiling,sourceDerivedBounds:bounds,fixedBound,output,releaseTail,endTail,referenceErrors:errors,scrubbedSamples:fx.diagnostics.scrubbedSamples};
    if(scenario==='ui-hold'&&controls==='default'){
     const filename=`sound-matrix-${instrument}-${effect}.wav`,wav=encodeWav(fx.outputs.main.map(channel=>Float32Array.from(channel,value=>value*masterDefault)),sampleRate);
     writeFileSync(filename,wav);row.candidate={filename,wavSha256:hash(wav),master:masterDefault,normalization:false};candidates.push(row.candidate);
    }
    measurements.push(row);
   }
  }
  console.log(JSON.stringify({instrument,scenario,sourcePeak:source[0].peak,frames:trace.frames,matrixRows:measurements.length}));
 }
}
assert.equal(sourceMeasurements.length,10);assert.equal(measurements.length,90);assert.equal(candidates.length,12);
const maximum=measurements.reduce((best,row)=>{const peak=Math.max(...row.output.map(stats=>stats.peak));return peak>best.peak?{peak,instrument:row.instrument,effect:row.effect,scenario:row.scenario,controls:row.controls}:best;},{peak:0});
const evidence={status:'CANDIDATE',runtimeGate:'NOT_CLEARED',physicalListening:'UNVERIFIED',normalization:false,sampleRate,masterDefault,masterMaximum,feedbackMaximum,maximumOutputCeiling,sourceCeilings,maximum,headroomDb:-20*Math.log10(maximum.peak),scope:'UI register at velocity 127; note/retrigger/release; mono overlapping last-held notes; poly chord and four coherent voices on every UI pitch; full Pad post-AD LFO period. Numerical regression only, not unrestricted MIDI or human listening approval.',sourceMeasurements,measurements,candidates};
writeFileSync('integration-sound-matrix.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({file:'integration-sound-matrix.json',matrixRows:measurements.length,maximum,headroomDb:evidence.headroomDb}));
