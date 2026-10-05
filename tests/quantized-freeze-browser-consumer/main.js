import {createNode} from '@unworklet/core';
import processor from './processor.ts?worklet';
window.runQuantizedFreeze=async()=>{
 const ctx=new AudioContext({sampleRate:48000}),errors=[];let node;
 try{
  node=await createNode(ctx,processor);node.onError(e=>errors.push({code:e.code,message:String(e.message??'')}));
  const split=new ChannelSplitterNode(ctx,{numberOfOutputs:12}),mute=new GainNode(ctx,{gain:0});node.outputs.main.connect(split);mute.connect(ctx.destination);
  const meters=Array.from({length:12},(_,ch)=>{const a=new AnalyserNode(ctx,{fftSize:2048});split.connect(a,ch);a.connect(mute);return a;});await ctx.resume();
  const read=async()=>{const until=ctx.currentTime+.1,deadline=performance.now()+10000;while(ctx.currentTime<until){if(performance.now()>deadline)throw new Error('Native audio clock did not advance');await new Promise(r=>setTimeout(r,10));}await ctx.suspend();
   try{return meters.map((a,ch)=>{const x=new Float32Array(a.fftSize);a.getFloatTimeDomainData(x);const result={mean:x.reduce((s,v)=>s+v,0)/x.length,peak:Math.max(...x.map(Math.abs)),finite:x.every(Number.isFinite)};if(ch===0){result.period=Array.from(x.slice(0,64));result.periodicityError=x.reduce((m,v,n)=>Math.max(m,Math.abs(v-x[n%64])),0);}return result;});}finally{await ctx.resume();}};
  const q={};q.initial=await read();
  for(const[name,value]of[['inside',61.6],['upperEquality',61.75],['upperOutside',61.75+2**-18],['lowerEquality',61.25],['lowerOutside',61.25-2**-18]]){node.params.pitch.value=value;q[name]=await read();}
  node.params.pitch.value=63;await read();node.params.pitch.value=61.5;q.beforeSave=await read();const quantizedState=await node.snapshot();
  node.params.pitch.value=60;q.mutated=await read();node.params.pitch.value=61.5;q.controlsPrepared=await read();
  q.restored=await node.restore(quantizedState);q.afterRestore=await read();node.params.pitchReset.value=1;q.resetHeld=await read();node.params.pitch.value=-5.1;q.negative=await read();node.params.pitchReset.value=0;node.params.pitch.value=61.5;await read();
  const f={};node.params.level.value=.25;node.params.freeze.value=0;node.params.reset.value=0;f.live=await read();node.params.freeze.value=1;f.held=await read();node.params.level.value=.75;f.inputChanged=await read();const capturedState=await node.snapshot();
  node.params.freeze.value=0;node.params.level.value=-.125;f.released=await read();node.params.freeze.value=1;f.negativeCapture=await read();
  // Keep the different capture intact while rendering every saved control.
  node.params.level.value=.75;node.params.freeze.value=1;node.params.reset.value=0;f.controlsPrepared=await read();
  f.restored=await node.restore(capturedState);f.afterRestore=await read();node.params.level.value=0;node.params.reset.value=1;f.reset=await read();node.params.reset.value=0;f.emptyHeld=await read();
  return{sampleRate:ctx.sampleRate,quantizer:q,spectral:f,errors};
 }finally{node?.dispose();await ctx.close();}
};
