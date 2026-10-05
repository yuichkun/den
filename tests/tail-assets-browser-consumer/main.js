import {createNode} from '@unworklet/core';
import {prepareConvolutionSpectrum} from '@denaudio/den/prepared-convolution';
import convolutionProcessor from './convolution-processor.ts?worklet';
import loopProcessor from './loop-processor.ts?worklet';
window.runTailAssets=async()=>{
 const config={blockSize:128,partitions:64},impulse=new Float32Array(8192);impulse[0]=.5;impulse[8191]=.25;
 const packet=prepareConvolutionSpectrum(impulse,config),shortPacket=prepareConvolutionSpectrum([-.25],config);
 const ctx=new AudioContext({sampleRate:48000}),errors=[];let convolution,loop;
 try{
  convolution=await createNode(ctx,convolutionProcessor);loop=await createNode(ctx,loopProcessor);
  for(const node of[convolution,loop])node.onError(e=>errors.push({code:e.code,message:String(e.message??'')}));
  const mute=new GainNode(ctx,{gain:0});mute.connect(ctx.destination);
  const meters=(node,count)=>{const split=new ChannelSplitterNode(ctx,{numberOfOutputs:count});node.outputs.main.connect(split);return Array.from({length:count},(_,ch)=>{const a=new AnalyserNode(ctx,{fftSize:256});split.connect(a,ch);a.connect(mute);return a;});};
  const convolutionMeters=meters(convolution,4),loopMeters=meters(loop,6);await ctx.resume();
  const read=async(analysers,seconds=.3)=>{const until=ctx.currentTime+seconds,deadline=performance.now()+10000;while(ctx.currentTime<until){if(performance.now()>deadline)throw new Error('Native audio clock did not advance');await new Promise(r=>setTimeout(r,10));}await ctx.suspend();
   try{return analysers.map(a=>{const x=new Float32Array(256);a.getFloatTimeDomainData(x);let re=0,im=0;for(let n=0;n<x.length;n++){const p=2*Math.PI*3*n/256;re+=x[n]*Math.cos(p);im-=x[n]*Math.sin(p);}return{samples:Array.from(x),mean:x.reduce((s,v)=>s+v,0)/256,peak:Math.max(...x.map(Math.abs)),finite:x.every(Number.isFinite),re:re/128,im:im/128,amplitude:Math.hypot(re,im)/128};});}finally{await ctx.resume();}};
  const c={};c.absent=await read(convolutionMeters);convolution.events.ir.emit(packet);c.full=await read(convolutionMeters);const savedConvolution=await convolution.snapshot();
  convolution.events.ir.emit({...packet,declaredValues:32767});c.rejected=await read(convolutionMeters);
  convolution.events.ir.emit({formatVersion:1,blockSize:128,partitions:64,impulseFrames:0,declaredValues:0,spectrum:new Float32Array(0)});c.unloaded=await read(convolutionMeters);
  convolution.events.ir.emit(shortPacket);c.short=await read(convolutionMeters);c.restored=await convolution.restore(savedConvolution);c.afterRestore=await read(convolutionMeters);
  convolution.params.reset.value=1;c.reset=await read(convolutionMeters);convolution.params.reset.value=0;c.restarted=await read(convolutionMeters);
  const l={};l.absent=await read(loopMeters,.05);loop.events.load.emit({data:Float32Array.from([.1,.2,.3,.4,.5,.6,.7,.8])});l.loaded=await read(loopMeters,.05);loop.params.gate.value=1;l.forward=await read(loopMeters,.05);loop.params.rate.value=-1;l.reverse=await read(loopMeters,.05);loop.params.rate.value=.5;l.fractional=await read(loopMeters,.05);const savedLoop=await loop.snapshot();
  loop.events.load.emit({data:Float32Array.from([.1,.2,.3])});l.replacedHeld=await read(loopMeters,.05);loop.params.gate.value=0;await read(loopMeters,.05);loop.params.gate.value=1;l.short=await read(loopMeters,.05);
  l.restored=await loop.restore(savedLoop);l.afterRestore=await read(loopMeters,.05);loop.params.gate.value=0;l.released=await read(loopMeters,.05);loop.params.gate.value=1;await read(loopMeters,.05);loop.params.reset.value=1;l.reset=await read(loopMeters,.05);loop.params.reset.value=0;l.restarted=await read(loopMeters,.05);
  loop.events.load.emit({data:new Float32Array(0)});l.unloaded=await read(loopMeters,.05);
  return{sampleRate:ctx.sampleRate,convolution:c,loop:l,errors};
 }finally{convolution?.dispose();loop?.dispose();await ctx.close();}
};
