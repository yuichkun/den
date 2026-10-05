import {createNode} from '@unworklet/core';
import recorderProcessor from './recorder-processor.ts?worklet';
import freezeProcessor from './freeze-processor.ts?worklet';
window.runCaptureFreeze=async()=>{
 const ctx=new AudioContext({sampleRate:48000}),errors=[];let recorder,freeze;
 try{
  recorder=await createNode(ctx,recorderProcessor);freeze=await createNode(ctx,freezeProcessor);
  for(const node of[recorder,freeze])node.onError(e=>errors.push({code:e.code,message:String(e.message??'')}));
  const mute=new GainNode(ctx,{gain:0});mute.connect(ctx.destination);
  const meters=(node,count)=>{const split=new ChannelSplitterNode(ctx,{numberOfOutputs:count});node.outputs.main.connect(split);return Array.from({length:count},(_,ch)=>{const a=new AnalyserNode(ctx,{fftSize:4096});split.connect(a,ch);a.connect(mute);return a;});};
  const recorderMeters=meters(recorder,7),freezeMeters=meters(freeze,8);await ctx.resume();
  const read=async(analysers,seconds=.12)=>{const until=ctx.currentTime+seconds,deadline=performance.now()+10000;while(ctx.currentTime<until){if(performance.now()>deadline)throw new Error('Native audio clock did not advance');await new Promise(r=>setTimeout(r,10));}await ctx.suspend();
   try{return analysers.map(a=>{const x=new Float32Array(a.fftSize);a.getFloatTimeDomainData(x);return{mean:x.reduce((s,v)=>s+v,0)/x.length,rms:Math.sqrt(x.reduce((s,v)=>s+v*v,0)/x.length),peak:Math.max(...x.map(Math.abs)),finite:x.every(Number.isFinite)};});}finally{await ctx.resume();}};
  const r={};r.empty=await read(recorderMeters);recorder.params.record.value=1;r.firstTake=await read(recorderMeters);recorder.params.play.value=1;r.firstPlayback=await read(recorderMeters);
  recorder.params.record.value=0;recorder.params.play.value=0;recorder.params.input.value=-.5;recorder.params.limit.value=128;r.paused=await read(recorderMeters);
  recorder.params.record.value=1;recorder.params.position.value=63;r.appended=await read(recorderMeters);recorder.params.position.value=64;r.boundary=await read(recorderMeters);
  recorder.params.input.value=.75;recorder.params.limit.value=512;recorder.params.position.value=255;r.full=await read(recorderMeters);recorder.params.input.value=-1;r.fullUnchanged=await read(recorderMeters);
  recorder.params.record.value=0;recorder.params.play.value=1;recorder.params.position.value=100;r.fullPlayback=await read(recorderMeters);const saved=await recorder.snapshot();
  recorder.params.play.value=0;recorder.params.record.value=1;recorder.params.reset.value=1;r.reset=await read(recorderMeters);recorder.params.reset.value=0;recorder.params.input.value=-.75;r.overwritten=await read(recorderMeters);
  r.restored=await recorder.restore(saved);r.afterRestore=await read(recorderMeters);
  recorder.params.record.value=0;recorder.params.play.value=0;await read(recorderMeters);recorder.events.load.emit({data:Float32Array.from([1,.5])});r.prefix=await read(recorderMeters);
  recorder.params.input.value=-.5;recorder.params.limit.value=4;recorder.params.record.value=1;recorder.params.position.value=1.5;r.prefixAppend=await read(recorderMeters);recorder.params.record.value=0;
  const f={};f.live=await read(freezeMeters,.2);freeze.params.freeze.value=1;freeze.params.level.value=0;f.frozen=await read(freezeMeters,.2);freeze.params.disturb.value=1;f.inputBlocked=await read(freezeMeters,.2);const frozenState=await freeze.snapshot();
  freeze.params.disturb.value=0;freeze.params.freeze.value=0;f.thawed=await read(freezeMeters,.8);freeze.params.reset.value=1;f.reset=await read(freezeMeters,.15);
  freeze.params.reset.value=0;freeze.params.disturb.value=1;f.mutated=await read(freezeMeters,.2);
  f.restored=await freeze.restore(frozenState);f.afterRestore=await read(freezeMeters,.2);freeze.params.reset.value=1;f.resetRestored=await read(freezeMeters,.15);freeze.params.reset.value=0;freeze.params.disturb.value=0;f.emptyFrozen=await read(freezeMeters,.2);
  return{sampleRate:ctx.sampleRate,recorder:r,freeze:f,errors};
 }finally{recorder?.dispose();freeze?.dispose();await ctx.close();}
};
