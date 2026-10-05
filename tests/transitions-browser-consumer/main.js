import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';
import { prepareWavetableBands } from '@denaudio/den/wavetable';
import waveProcessor from './wave-processor.ts?worklet';
import mpeProcessor from './mpe-processor.ts?worklet';
window.runTransitions = async () => {
 const ctx=new AudioContext({sampleRate:48000}),errors=[];let node,mpe,wave;
 try {
  node=await createNode(ctx,processor);mpe=await createNode(ctx,mpeProcessor,{initial:{a4:375,gain:.2,release:.01}});
  wave=await createNode(ctx,waveProcessor);
  for(const n of [node,mpe,wave])n.onError(e=>errors.push({code:e.code,message:String(e.message??'')}));
  const mute=new GainNode(ctx,{gain:0});mute.connect(ctx.destination);
  const splitter=new ChannelSplitterNode(ctx,{numberOfOutputs:10});node.outputs.main.connect(splitter);
  const analysers=Array.from({length:10},(_,ch)=>{const a=new AnalyserNode(ctx,{fftSize:256});splitter.connect(a,ch);a.connect(mute);return a;});
  const mpeAnalysers=['main','frequency','level'].map(key=>{const a=new AnalyserNode(ctx,{fftSize:256});mpe.outputs[key].connect(a);a.connect(mute);return a;});
  const waveSplit=new ChannelSplitterNode(ctx,{numberOfOutputs:2});wave.outputs.main.connect(waveSplit);
  const waveAnalysers=[0,1].map(ch=>{const a=new AnalyserNode(ctx,{fftSize:256});waveSplit.connect(a,ch);a.connect(mute);return a;});
  await ctx.resume();
  const read=async(target=analysers)=>{
   const until=ctx.currentTime+.2,deadline=performance.now()+10000;
   while(ctx.currentTime<until){if(performance.now()>deadline)throw new Error('Native audio clock did not advance');await new Promise(r=>setTimeout(r,10));}
   return target.map(a=>{const x=new Float32Array(256);a.getFloatTimeDomainData(x);
    const bins=Object.fromEntries([1,2,4,6,14,64].map(k=>{let re=0,im=0;for(let n=0;n<256;n++){const w=2*Math.PI*k*n/256;re+=x[n]*Math.cos(w);im-=x[n]*Math.sin(w);}return[k,{re:re/128,im:im/128,amplitude:Math.hypot(re,im)/128}];}));
    return{mean:x.reduce((s,v)=>s+v,0)/256,peak:Math.max(...x.map(Math.abs)),finite:x.every(Number.isFinite),bins};});
  };
  const initial=await read(),saved=await node.snapshot();
  node.params.ratio.value=2;node.params.time.value=24/48000;node.params.gain.value=2;const up=await read();
  node.params.ratio.value=.5;node.params.mix.value=0;const downDry=await read();
  // State restore and host AudioParam restoration are not atomic in 0.4.1.
  // Render every saved control first, without resetting/retriggering pitch state.
  node.params.ratio.value=1;node.params.time.value=Math.fround(8/48000);node.params.gain.value=1;node.params.mix.value=1;node.params.reset.value=0;
  const controlsPrepared=await read();
  const restored=await node.restore(saved),afterRestore=await read();
  node.params.reset.value=1;const reset=await read();
  const send=(channel,payload)=>mpe.midi.midi.send({channel,...payload}),cc=(channel,controller,value)=>send(channel,{type:'cc',controller,value});
  const quiet=await read(mpeAnalysers);send(1,{type:'noteOn',note:69,velocity:127});const note=await read(mpeAnalysers);
  send(1,{type:'pitchBend',value:16383});const member=await read(mpeAnalysers);
  send(0,{type:'pitchBend',value:0});const summed=await read(mpeAnalysers);
  for(const channel of [0,1]){send(channel,{type:'channelPressure',pressure:127});cc(channel,74,127);}const expressive=await read(mpeAnalysers);
  cc(1,64,127);send(1,{type:'noteOff',note:69,velocity:0});const sustained=await read(mpeAnalysers),held=await mpe.snapshot();
  const liveRestored=await mpe.restore(held),liveHeld=await read(mpeAnalysers);
  cc(1,64,0);const released=await read(mpeAnalysers);
  const mpeRestored=await mpe.restore(held),mpeAfterRestore=await read(mpeAnalysers);
  send(2,{type:'noteOn',note:69,velocity:127});const inherited=await read(mpeAnalysers);
  // Native live restore overlays persistent slots; it does not reset excluded
  // notes/controllers. Use the composition's existing explicit reset and let
  // it render before sending new notes when a cold restore is desired.
  mpe.events.reset.emit({value:1});const resetBeforeRestore=await read(mpeAnalysers);
  const coldRestored=await mpe.restore(held),cold=await read(mpeAnalysers);
  send(2,{type:'noteOn',note:69,velocity:127});const fresh=await read(mpeAnalysers);
  cc(2,120,0);const panic=await read(mpeAnalysers);
  const absent=await read(waveAnalysers);
  const frames=Array.from({length:2},(_,f)=>Float32Array.from({length:64},(_,n)=>{const p=2*Math.PI*n/64;return .02*f+(1+f)*(.1*Math.sin(p)+.05*Math.sin(3*p)+.025*Math.sin(7*p));}));
  const prepared=prepareWavetableBands({frames});wave.events.load.emit({data:prepared.data});const low=await read(waveAnalysers);
  wave.params.frequency.value=12000;wave.params.reset.value=1;await read(waveAnalysers);wave.params.reset.value=0;const high=await read(waveAnalysers);wave.params.frame.value=1;const morphed=await read(waveAnalysers),waveSaved=await wave.snapshot();
  wave.events.load.emit({data:new Float32Array([1])});const short=await read(waveAnalysers);
  const waveRestored=await wave.restore(waveSaved),waveAfterRestore=await read(waveAnalysers);wave.params.reset.value=1;const waveReset=await read(waveAnalysers);
  return{wave:{absent,low,high,morphed,short,restored:waveRestored,afterRestore:waveAfterRestore,reset:waveReset},sampleRate:ctx.sampleRate,initial,up,downDry,controlsPrepared,restored,afterRestore,reset,mpe:{quiet,note,member,summed,expressive,sustained,liveRestored,liveHeld,released,restored:mpeRestored,afterRestore:mpeAfterRestore,inherited,resetBeforeRestore,coldRestored,cold,fresh,panic},errors};
 }finally{node?.dispose();mpe?.dispose();wave?.dispose();await ctx.close();}
};
