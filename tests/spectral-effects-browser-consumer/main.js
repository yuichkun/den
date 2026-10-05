import {createNode} from '@unworklet/core';
import processor from './processor.ts?worklet';
window.runSpectralGate=async()=>{
 const ctx=new AudioContext({sampleRate:48000}),errors=[];let node;
 try{
  node=await createNode(ctx,processor);node.onError(e=>errors.push({code:e.code,message:String(e.message??'')}));
  const mute=new GainNode(ctx,{gain:0}),split=new ChannelSplitterNode(ctx,{numberOfOutputs:2});node.outputs.main.connect(split);mute.connect(ctx.destination);
  const analysers=[0,1].map(ch=>{const a=new AnalyserNode(ctx,{fftSize:256});split.connect(a,ch);a.connect(mute);return a;});await ctx.resume();
  const read=async()=>{const until=ctx.currentTime+.15,deadline=performance.now()+10000;while(ctx.currentTime<until){if(performance.now()>deadline)throw new Error('Native audio clock did not advance');await new Promise(r=>setTimeout(r,10));}
   return analysers.map(a=>{const x=new Float32Array(256);a.getFloatTimeDomainData(x);let re=0,im=0;for(let n=0;n<256;n++){re+=x[n]*Math.cos(2*Math.PI*8*n/256);im-=x[n]*Math.sin(2*Math.PI*8*n/256);}return{peak:Math.max(...x.map(Math.abs)),finite:x.every(Number.isFinite),re:re/128,im:im/128,amplitude:Math.hypot(re,im)/128};});};
  const initial=await read();node.params.threshold.value=100;node.params.floor.value=.25;const attenuated=await read(),saved=await node.snapshot();node.params.floor.value=0;const closed=await read();node.params.floor.value=1;const openFloor=await read();const restored=await node.restore(saved),afterRestore=await read();node.params.reset.value=1;const reset=await read();node.params.reset.value=0;const restarted=await read();return{sampleRate:ctx.sampleRate,initial,attenuated,closed,openFloor,restored,afterRestore,reset,restarted,errors};
 }finally{node?.dispose();await ctx.close();}
};
