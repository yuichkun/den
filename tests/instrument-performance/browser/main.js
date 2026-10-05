import {createNode} from '@unworklet/core';
import one from './one.ts?worklet';
import four from './four.ts?worklet';
import sixteen from './sixteen.ts?worklet';
import oscillator from './oscillator.ts?worklet';
const processors={one,four,sixteen,oscillator};
window.diagnosticRun=async({kind,active=4,seconds=12,poll=true})=>{
 const context=new AudioContext({sampleRate:48000});await context.suspend();
 const frames=seconds*48000,quanta=frames/128,errors=[],params={gain:0.02,ampAttack:0,ampDecay:0,ampSustain:1,ampRelease:1,pitchEnvelopeDepth:0,filterEnvelopeDepth:0,lfoAmpDepth:0,lfoPitchDepth:0,lfoFilterDepth:0,cutoff:1000,resonance:0.5};
 const sourceCode=`class Capture extends AudioWorkletProcessor {
 constructor(){super();this.raw=[new Float32Array(${frames}),new Float32Array(${frames})];this.entry=new Float64Array(${quanta});this.exit=new Float64Array(${quanta});this.time=new Float64Array(${quanta});this.lengths=new Uint16Array(${quanta});this.at=0;this.armed=false;this.finished=false;this.port.onmessage=()=>{this.armed=true;};}
 process(inputs){
  const entry=currentFrame;
  if(this.armed&&!this.finished){const q=this.at/128;this.entry[q]=entry;this.time[q]=currentTime;
   const input=inputs[0];this.lengths[q]=input[0]?.length??0;
   for(let c=0;c<2;c++)if(input[c])this.raw[c].set(input[c],this.at);
   this.exit[q]=currentFrame;this.at+=128;
   if(this.at===${frames}){this.finished=true;this.port.postMessage({raw:this.raw,entry:this.entry,exit:this.exit,time:this.time,lengths:this.lengths},[...this.raw.map(x=>x.buffer),this.entry.buffer,this.exit.buffer,this.time.buffer,this.lengths.buffer]);}
  }
  return true;
 }
}registerProcessor('capture',Capture);`;
 const url=URL.createObjectURL(new Blob([sourceCode],{type:'text/javascript'}));await context.audioWorklet.addModule(url);URL.revokeObjectURL(url);
 const capture=new AudioWorkletNode(context,'capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],channelCount:2,channelCountMode:'explicit'});
 capture.onprocessorerror=()=>errors.push({kind:'capture-error'});
 capture.connect(context.destination);
 let source,stop,timer,createNodeMs;const timestamps=[];let watchdog;
 const finish=new Promise((resolve,reject)=>{capture.port.onmessage=e=>resolve(e.data);watchdog=setTimeout(()=>reject(new Error('Capture timeout')),45000);});
 const until=async(t)=>{const timeout=performance.now()+45000;while(context.currentTime<t){if(performance.now()>timeout)throw new Error('Audio clock stalled');await new Promise(r=>setTimeout(r,10));}};
 const playback={initial:context.playbackStats?.toJSON()??null};
 const wallStart=performance.now();
 try{
  if(kind==='native-counter'){
   const buffer=context.createBuffer(2,Math.ceil((seconds+4)*48000),48000),left=buffer.getChannelData(0),right=buffer.getChannelData(1);
   for(let n=0;n<left.length;n++){left[n]=0.08*Math.sin(2*Math.PI*440*n/48000);right[n]=n/1048576;}
   source=new AudioBufferSourceNode(context,{buffer});source.connect(capture);source.start(0.1);stop=()=>source.stop();
  }else{
   const createStart=performance.now();source=await createNode(context,processors[kind],{initial:kind==='oscillator'?{}:params});createNodeMs=performance.now()-createStart;
   source.onError(e=>errors.push(e));source.outputs.main.connect(capture);stop=()=>source.dispose();
   if(kind!=='oscillator')for(let n=0;n<active;n++)source.midi.midi.send({type:'noteOn',note:69,velocity:127,channel:0},0.1);
  }
  await context.resume();await until(context.currentTime+0.5);playback.warm={contextTime:context.currentTime,stats:context.playbackStats?.toJSON()??null};capture.port.postMessage('start');
  if(poll)timer=setInterval(()=>timestamps.push({...context.getOutputTimestamp(),observedAt:performance.now()}),20);
  const data=await finish;playback.final={contextTime:context.currentTime,stats:context.playbackStats?.toJSON()??null};
  return {createNodeMs,playback,kind,active,seconds,poll,params,errors,timestamps,wallElapsedMs:performance.now()-wallStart,sampleRate:context.sampleRate,baseLatency:context.baseLatency,outputLatency:context.outputLatency,raw:data.raw.map(x=>Array.from(x)),entry:Array.from(data.entry),exit:Array.from(data.exit),time:Array.from(data.time),lengths:Array.from(data.lengths)};
 }finally{clearInterval(timer);clearTimeout(watchdog);stop?.();capture.disconnect();await context.close();}
};

// Timing control without the observation AudioWorklet. Only the final native
// Analyser window is captured; this is not a twelve-second continuity proof.
window.diagnosticUnobserved=async({kind,seconds=12})=>{
 const context=new AudioContext({sampleRate:48000});await context.suspend();
 const analyser=new AnalyserNode(context,{fftSize:32768}),mute=new GainNode(context,{gain:0});
 analyser.connect(mute).connect(context.destination);
 const params={gain:0.02,ampAttack:0,ampDecay:0,ampSustain:1,ampRelease:1,pitchEnvelopeDepth:0,filterEnvelopeDepth:0,lfoAmpDepth:0,lfoPitchDepth:0,lfoFilterDepth:0,cutoff:1000,resonance:0.5},errors=[];
 let source,stop;const playback={initial:context.playbackStats?.toJSON()??null};const start=performance.now();
 try{
  if(kind==='native-unobserved'){
   const buffer=context.createBuffer(1,(seconds+4)*48000,48000),audio=buffer.getChannelData(0);
   for(let n=0;n<audio.length;n++)audio[n]=0.08*Math.sin(2*Math.PI*440*n/48000);
   source=new AudioBufferSourceNode(context,{buffer});source.connect(analyser);source.start(0.1);stop=()=>source.stop();
  }else{
   source=await createNode(context,kind==='oscillator-unobserved'?oscillator:four,{initial:kind==='oscillator-unobserved'?{}:params});source.onError(e=>errors.push(e));source.outputs.main.connect(analyser);stop=()=>source.dispose();
   if(kind!=='oscillator-unobserved')for(let n=0;n<4;n++)source.midi.midi.send({type:'noteOn',note:69,velocity:127,channel:0},0.1);
  }
  await context.resume();const timeout=performance.now()+45000;
  while(context.currentTime<seconds+0.5){if(performance.now()>timeout)throw new Error('Unobserved audio clock stalled');await new Promise(r=>setTimeout(r,20));if(!playback.warm&&context.currentTime>=1)playback.warm={contextTime:context.currentTime,stats:context.playbackStats?.toJSON()??null};}
  const audio=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(audio);
  playback.final={contextTime:context.currentTime,stats:context.playbackStats?.toJSON()??null};
  return {playback,kind,seconds,params,errors,wallElapsedMs:performance.now()-start,sampleRate:context.sampleRate,baseLatency:context.baseLatency,outputLatency:context.outputLatency,observationMode:'final native Analyser window only; no full-stream or currentFrame observation',raw:[Array.from(audio),Array.from(audio)],entry:[],exit:[],time:[],lengths:[],timestamps:[]};
 }finally{stop?.();await context.close();}
};
