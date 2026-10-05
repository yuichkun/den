import {createNode} from '@unworklet/core';
import processor from './fx-processor.ts?worklet';
window.runCatalogFx=async()=>{
 const ctx=new AudioContext({sampleRate:48000}),source=new ConstantSourceNode(ctx,{offset:.1}),errors=[];let node;
 try{
  node=await createNode(ctx,processor);node.onError(error=>errors.push({...error,message:String(error.message??'')}));
  const splitter=new ChannelSplitterNode(ctx,{numberOfOutputs:9}),mute=new GainNode(ctx,{gain:0});source.connect(node.inputs.main);node.outputs.main.connect(splitter);
  const analysers=Array.from({length:9},(_,ch)=>{const a=new AnalyserNode(ctx,{fftSize:256});splitter.connect(a,ch);a.connect(mute);return a;});mute.connect(ctx.destination);source.start();await ctx.resume();
  const read=async(seconds)=>{const until=ctx.currentTime+seconds;while(ctx.currentTime<until)await new Promise(resolve=>setTimeout(resolve,10));return analysers.map(a=>{const x=new Float32Array(256);a.getFloatTimeDomainData(x);return {mean:x.reduce((s,v)=>s+v,0)/256,peak:Math.max(...x.map(Math.abs)),finite:x.every(Number.isFinite)};});};
  const active=await read(.3),saved=await node.snapshot(),restored=await node.restore(saved);source.offset.value=0;const tail=await read(.9);
  return {sampleRate:ctx.sampleRate,active,restored,tail,errors};
 }finally{try{source.stop();}catch{}node?.dispose();await ctx.close();}
};
