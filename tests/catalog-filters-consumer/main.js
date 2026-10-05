import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';
window.runCatalogFilters=async()=>{
 const ctx=new AudioContext({sampleRate:48000}),source=new ConstantSourceNode(ctx,{offset:.25}),errors=[];
 let node;
 try{
  node=await createNode(ctx,processor,{initial:{cutoff:1000,gain:12,reset:0}});node.onError(error=>errors.push({...error,message:String(error.message??"" )}));
  const split=new ChannelSplitterNode(ctx,{numberOfOutputs:5}),mute=new GainNode(ctx,{gain:0});
  source.connect(node.inputs.main);node.outputs.main.connect(split);
  const analysers=Array.from({length:5},(_,ch)=>{const a=new AnalyserNode(ctx,{fftSize:256});split.connect(a,ch);a.connect(mute);return a;});mute.connect(ctx.destination);source.start();await ctx.resume();
  const read=async()=>{const until=ctx.currentTime+.3;while(ctx.currentTime<until)await new Promise(resolve=>setTimeout(resolve,10));return analysers.map(a=>{const x=new Float32Array(256);a.getFloatTimeDomainData(x);return {peak:Math.max(...x.map(Math.abs)),mean:x.reduce((s,v)=>s+v,0)/x.length,finite:x.every(Number.isFinite)};});};
  const active=await read();source.offset.value=0;node.params.reset.value=1;const cleared=await read();
  const snapshot=await node.snapshot(),restored=await node.restore(snapshot);
  return {sampleRate:ctx.sampleRate,active,cleared,restored,errors};
 }finally{try{source.stop();}catch{}node?.dispose();await ctx.close();}
};
