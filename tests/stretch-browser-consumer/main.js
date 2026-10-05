import {createNode} from '@unworklet/core';
import toneProcessor from './processor.ts?worklet';
import durationProcessor from './duration-processor.ts?worklet';
window.runResidentStretch=async()=>{
 const ctx=new AudioContext({sampleRate:48000}),errors=[];let tone,short;
 try{
  tone=await createNode(ctx,toneProcessor);short=await createNode(ctx,durationProcessor);
  for(const node of[tone,short])node.onError(e=>errors.push({code:e.code,message:String(e.message??'')}));
  const mute=new GainNode(ctx,{gain:0});mute.connect(ctx.destination);
  const meters=node=>{const split=new ChannelSplitterNode(ctx,{numberOfOutputs:10});node.outputs.main.connect(split);return Array.from({length:10},(_,ch)=>{const a=new AnalyserNode(ctx,{fftSize:2048});split.connect(a,ch);a.connect(mute);return a;});};
  const tm=meters(tone),sm=meters(short);await ctx.resume();
  const read=async(analysers,seconds=.1)=>{const until=ctx.currentTime+seconds,deadline=performance.now()+10000;while(ctx.currentTime<until){if(performance.now()>deadline)throw new Error('Native audio clock did not advance');await new Promise(r=>setTimeout(r,10));}await ctx.suspend();
   try{return analysers.map((a,ch)=>{const x=new Float32Array(a.fftSize);a.getFloatTimeDomainData(x);const stats={mean:x.reduce((s,v)=>s+v,0)/x.length,rms:Math.sqrt(x.reduce((s,v)=>s+v*v,0)/x.length),peak:Math.max(...x.map(Math.abs)),finite:x.every(Number.isFinite)};
    if(ch===0)stats.amplitudes=Object.fromEntries([16,32,64].map(k=>{let re=0,im=0;for(let n=0;n<x.length;n++){const phase=2*Math.PI*k*n/x.length;re+=x[n]*Math.cos(phase);im-=x[n]*Math.sin(phase);}return[k,2*Math.hypot(re,im)/x.length];}));return stats;});}finally{await ctx.resume();}};
  const result={duration:[],tone:{}};
  short.events.load.emit({data:new Float32Array(147).fill(.25)});tone.events.load.emit({data:Float32Array.from({length:65536},(_,n)=>.5*Math.cos(2*Math.PI*n/64))});
  result.loaded={short:await read(sm),tone:await read(tm)};
  for(const duration of[.5,1,2])for(const pitch of[1,2]){short.params.gate.value=0;short.params.reset.value=1;await read(sm);short.params.duration.value=duration;short.params.pitch.value=pitch;short.params.reset.value=0;short.params.gate.value=1;result.duration.push({duration,pitch,observed:await read(sm)});}
  tone.params.duration.value=.5;tone.params.pitch.value=1;tone.params.gate.value=1;result.tone.initial=await read(tm);
  tone.params.duration.value=2;tone.params.pitch.value=2;result.tone.latched=await read(tm);result.tone.eof=await read(tm,.7);
  tone.params.trigger.value=1;result.tone.retrigger=await read(tm);tone.params.trigger.value=0;result.tone.beforeSave=await read(tm);const saved=await tone.snapshot();
  tone.events.load.emit({data:new Float32Array(16384).fill(.125)});result.tone.replacedHeld=await read(tm);tone.params.trigger.value=1;result.tone.replacementPlayed=await read(tm);tone.params.trigger.value=0;
  result.tone.restored=await tone.restore(saved);result.tone.afterRestore=await read(tm);
  tone.params.reset.value=1;result.tone.reset=await read(tm);tone.params.gate.value=0;tone.params.reset.value=0;tone.events.load.emit({data:new Float32Array(0)});result.tone.unloaded=await read(tm);
  return{sampleRate:ctx.sampleRate,...result,errors};
 }finally{tone?.dispose();short?.dispose();await ctx.close();}
};
