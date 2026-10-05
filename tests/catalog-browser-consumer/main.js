import './fx-main.js';
import {createNode} from '@unworklet/core';
import processor from './processor.ts?worklet';
window.runCatalogComposition=async()=>{
 const ctx=new AudioContext({sampleRate:48000}),source=new ConstantSourceNode(ctx,{offset:.25}),errors=[];let node;
 try{
  node=await createNode(ctx,processor,{initial:{driveGain:4,threshold:-18,reset:0}});node.onError(error=>errors.push({...error,message:String(error.message??'')}));
  const splitter=new ChannelSplitterNode(ctx,{numberOfOutputs:4}),mute=new GainNode(ctx,{gain:0});source.connect(node.inputs.main);node.outputs.main.connect(splitter);
  const analysers=Array.from({length:4},(_,ch)=>{const a=new AnalyserNode(ctx,{fftSize:256});splitter.connect(a,ch);a.connect(mute);return a;});mute.connect(ctx.destination);source.start();await ctx.resume();
  const read=async()=>{const until=ctx.currentTime+.12;while(ctx.currentTime<until)await new Promise(resolve=>setTimeout(resolve,10));return analysers.map(a=>{const x=new Float32Array(256);a.getFloatTimeDomainData(x);return {mean:x.reduce((s,v)=>s+v,0)/256,peak:Math.max(...x.map(Math.abs)),finite:x.every(Number.isFinite)};});};
  const compressed=await read(),saved=await node.snapshot();node.params.threshold.value=24;const open=await read();
  const restored=await node.restore(saved),afterRestore=await read();source.offset.value=0;node.params.reset.value=1;const cleared=await read();
  return {sampleRate:ctx.sampleRate,compressed,open,restored,afterRestore,cleared,errors};
 }finally{try{source.stop();}catch{}node?.dispose();await ctx.close();}
};
