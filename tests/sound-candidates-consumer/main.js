import { createNode } from '@unworklet/core';
import { bassParameters, percussionParameters, padParameters } from '@denaudio/den/instrument';
import bass from './bass.ts?worklet';
import percussion from './percussion.ts?worklet';
import pad from './pad.ts?worklet';
const candidates={bass:{processor:bass,parameters:bassParameters,notes:[36]},percussion:{processor:percussion,parameters:percussionParameters,notes:[36]},pad:{processor:pad,parameters:padParameters,notes:[48,55,60,64]}};
window.runSoundCandidate=async name=>{
  const {processor,parameters,notes}=candidates[name];
  const context=new AudioContext({sampleRate:48000});await context.suspend();
  let node;
  const errors=[];
  const analyser=new AnalyserNode(context,{fftSize:2048});const mute=new GainNode(context,{gain:0});analyser.connect(mute).connect(context.destination);
  const attach=async initial=>{const next=await createNode(context,processor,{initial});next.outputs.main.connect(analyser);next.onError(e=>errors.push(JSON.stringify(e)));return next;};
  const capture=async seconds=>{
    const target=context.currentTime+seconds,deadline=performance.now()+15000;
    await context.resume();while(context.currentTime<target){if(performance.now()>deadline)throw new Error('Audio clock stalled');await new Promise(r=>setTimeout(r,5));}
    const audio=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(audio);await context.suspend();
    return {rms:Math.sqrt(audio.reduce((sum,x)=>sum+x*x,0)/audio.length),peak:audio.reduce((p,x)=>Math.max(p,Math.abs(x)),0),finite:audio.every(Number.isFinite)};
  };
  const on=()=>notes.forEach(note=>node.midi.midi.send({type:'noteOn',note,velocity:100,channel:0}));
  const off=()=>notes.forEach(note=>node.midi.midi.send({type:'noteOff',note,velocity:0,channel:0}));
  const attackSeconds=name==='percussion'?0.08:1;
  try {
    node=await attach(parameters);const initialParameters=Object.fromEntries(Object.keys(parameters).map(key=>[key,node.params[key].value]));
    const silent=await capture(0.1);on();const active=await capture(attackSeconds);off();const released=await capture(parameters.ampRelease+0.2);
    on();await capture(attackSeconds);node.events.reset.emit({value:1});const reset=await capture(0.1);
    node.params.bypass.value=1;on();const bypassed=await capture(0.08);node.params.bypass.value=0;
    node.events.reset.emit({value:1});await capture(0.1);on();const restarted=await capture(attackSeconds);
    const saved=await node.snapshot();const restoredInPlace=await node.restore(saved);node.events.reset.emit({value:1});const clearedAfterRestore=await capture(0.1);on();const inPlaceAttack=await capture(attackSeconds);
    node.dispose();node=await attach();const restored=await node.restore(saved);const restoredSilence=await capture(0.1);
    const restoredParameters=Object.fromEntries(Object.keys(parameters).map(key=>[key,node.params[key].value]));on();const restoredAttack=await capture(attackSeconds);off();const ended=await capture(parameters.ampRelease+0.2);
    return {name,sampleRate:context.sampleRate,initialParameters,restoredParameters,silent,active,released,reset,bypassed,restarted,restoredInPlace,clearedAfterRestore,inPlaceAttack,restored,restoredSilence,restoredAttack,ended,errors};
  } finally {node?.dispose();analyser.disconnect();mute.disconnect();await context.close();}
};
