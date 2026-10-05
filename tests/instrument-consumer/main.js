import { createNode } from '@unworklet/core';
import processor from './processor.ts?worklet';
window.runInstrument = async () => {
  const context = new AudioContext({ sampleRate: 48000 });
  await context.suspend();
  let node = await createNode(context, processor, { initial: {
    gain: 0.2, ampAttack: 0, ampDecay: 0, ampSustain: 1, ampRelease: 0.05,
    pitchEnvelopeDepth: 0, filterEnvelopeDepth: 0, cutoff: 1000, resonance: 0.707,
  } });
  const analyser = new AnalyserNode(context, { fftSize: 2048 });
  const mute = new GainNode(context, { gain: 0 });
  node.outputs.main.connect(analyser); analyser.connect(mute).connect(context.destination);
  const capture = async () => {
    const until = context.currentTime + 0.2;
    await context.resume();
    while (context.currentTime < until) await new Promise(r => setTimeout(r, 10));
    const audio = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(audio);
    await context.suspend();
    return { rms: Math.sqrt(audio.reduce((s,x) => s+x*x,0)/audio.length), peak: Math.max(...audio.map(Math.abs)), finite: audio.every(Number.isFinite) };
  };
  const on = () => node.midi.midi.send({type:'noteOn',note:69,velocity:127,channel:0});
  const off = () => node.midi.midi.send({type:'noteOff',note:69,velocity:0,channel:0});
  try {
    const silent = await capture();
    on(); const single = await capture();
    node.params.gain.value = 0.1; const changed = await capture();
    node.params.cutoff.value = 100; const filtered = await capture();
    node.params.cutoff.value = 1000; node.params.gain.value = 0.2;
    node.params.bypass.value = 1; const bypassed = await capture();
    node.params.bypass.value = 0; const resumed = await capture();
    node.events.reset.emit({value:1}); const reset = await capture();
    on(); on(); const chord = await capture();
    off(); const oneRelease = await capture();
    off(); const ended = await capture();
    on(); const restarted = await capture();
    node.params.bypass.value = 1; await capture(); off(); await capture();
    node.params.bypass.value = 0; const endedWhileBypassed = await capture();
    node.params.ampAttack.value = 1;
    on(); const freshAttack = await capture();
    const saved = await node.snapshot();
    const restoredInPlace = await node.restore(saved);
    // Native in-place restore overlays persistent slots; transient live voices
    // remain live. Use the instrument's existing panic before starting afresh.
    node.events.reset.emit({value:1}); const clearedAfterRestore = await capture();
    on(); const inPlaceAttack = await capture();
    node.dispose();
    node = await createNode(context, processor);
    node.outputs.main.connect(analyser);
    const restored = await node.restore(saved);
    on(); const restoredAttack = await capture();
    return {sampleRate:context.sampleRate,silent,single,changed,filtered,bypassed,resumed,reset,chord,oneRelease,ended,restarted,endedWhileBypassed,freshAttack,restoredAttack,restored,restoredInPlace,clearedAfterRestore,inPlaceAttack};
  } finally { node.dispose(); await context.close(); }
};

import sustainedProcessor from './sustained-processor.ts?worklet';
// Dedicated observation-only fixture. It copies the browser's actual rendered
// output into a fixed buffer; it does not generate/process the instrument audio.
window.runSustainedInstrument = async () => {
  const context = new AudioContext({sampleRate:48000});
  await context.suspend();
  const errors=[];
  const node=await createNode(context,sustainedProcessor,{initial:{
    gain:0.02,ampAttack:0,ampDecay:0,ampSustain:1,ampRelease:1,
    pitchEnvelopeDepth:0,filterEnvelopeDepth:0,lfoAmpDepth:0,lfoPitchDepth:0,lfoFilterDepth:0,
    cutoff:1000,resonance:0.5,
  }});
  node.onError(e=>errors.push(JSON.stringify(e)));
  const source=`class InstrumentCapture extends AudioWorkletProcessor {
    constructor(){super();this.audio=new Float32Array(576000);this.reference=new Float32Array(576000);this.audioLengths=new Uint16Array(4500);this.referenceLengths=new Uint16Array(4500);this.offsets=new Uint32Array(4500);this.entries=new Float64Array(4500);this.exits=new Float64Array(4500);this.at=0;this.blocks=0;this.start=null;this.last=null;this.gaps=[];this.captureErrors=[];this.done=false;this.port.onmessage=e=>{if(e.data==='start'){this.armed=true;this.port.postMessage({kind:'armed'});}};}
    complete(){this.done=true;this.port.postMessage({kind:'complete',audio:this.audio,reference:this.reference,startFrame:this.start,gaps:this.gaps,capturedSamples:this.at,capturedBlocks:this.blocks,captureErrors:this.captureErrors,audioBlockLengths:this.audioLengths,referenceBlockLengths:this.referenceLengths,sampleOffsets:this.offsets,clockEntries:this.entries,clockExits:this.exits},[this.audio.buffer,this.reference.buffer,this.audioLengths.buffer,this.referenceLengths.buffer,this.offsets.buffer,this.entries.buffer,this.exits.buffer]);}
    process(inputs,outputs){
      if(!this.armed||this.done)return true;
      const reference=inputs[1]?.[0],input=inputs[0]?.[0];
      // Await the first complete native ramp quantum, not a local counter.
      // Once capture starts, missing/short input is an explicit failure.
      if(this.at===0&&(!reference||!(reference[0]>0)))return true;
      const entry=currentFrame,block=this.blocks;
      if(this.start===null)this.start=entry;
      if(this.last!==null&&entry!==this.last+128)this.gaps.push({block,previous:this.last,current:entry});
      this.last=entry;this.entries[block]=entry;this.audioLengths[block]=input?.length??0;this.referenceLengths[block]=reference?.length??0;this.offsets[block]=this.at;
      if(input?.length!==128||reference?.length!==128){this.captureErrors.push({block,audioLength:input?.length??0,referenceLength:reference?.length??0});this.exits[block]=currentFrame;this.blocks++;this.complete();return true;}
      this.audio.set(input,this.at);this.reference.set(reference,this.at);this.at+=128;this.exits[block]=currentFrame;this.blocks++;
      if(this.at===576000)this.complete();
      return true;
    }
  } registerProcessor('instrument-capture',InstrumentCapture);`;
  const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
  await context.audioWorklet.addModule(url);URL.revokeObjectURL(url);
  const capture=new AudioWorkletNode(context,'instrument-capture',{numberOfInputs:2,numberOfOutputs:1,outputChannelCount:[1]});
  capture.onprocessorerror=e=>console.error('Capture processor error',String(e));
  node.outputs.main.connect(capture,0,0);capture.connect(context.destination); // observer output is zero
  const referenceBuffer=context.createBuffer(1,576000+256,48000);
  const referenceData=referenceBuffer.getChannelData(0);
  for(let n=0;n<referenceData.length;n++)referenceData[n]=(n+1)/1048576;
  const referenceSource=new AudioBufferSourceNode(context,{buffer:referenceBuffer,playbackRate:1,detune:0,loop:false});
  referenceSource.connect(capture,0,1);
  const waitUntil=async(time)=>{const limit=performance.now()+30000;while(context.currentTime<time){if(performance.now()>limit)throw new Error(`Audio clock stalled at ${context.currentTime}, target ${time}`);await new Promise(r=>setTimeout(r,10));}};
  const timestamps=[];let timer;
  try {
    for(let n=0;n<4;n++)node.midi.midi.send({type:'noteOn',note:69,velocity:127,channel:0},context.currentTime+0.1);
    await context.resume();await waitUntil(context.currentTime+0.5);
    let resolveArmed,resolveComplete;
    const armed=new Promise(resolve=>{resolveArmed=resolve;}),completed=new Promise(resolve=>{resolveComplete=resolve;});
    capture.port.onmessage=e=>{if(e.data.kind==='armed')resolveArmed();else if(e.data.kind==='complete')resolveComplete(e.data);};
    capture.port.postMessage('start');
    await Promise.race([armed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Capture observer did not arm')),10000))]);
    const startTime=context.currentTime;referenceSource.start();
    // Keep timestamp diagnostics, including their potential publication/lock
    // anomalies. They are no longer substituted for native sample progression.
    timer=setInterval(()=>{const t=context.getOutputTimestamp();timestamps.push({contextTime:t.contextTime,performanceTime:t.performanceTime,observedAt:performance.now()});},20);
    await waitUntil(startTime+8);
    const releaseTime=context.currentTime+0.1;
    for(let n=0;n<4;n++)node.midi.midi.send({type:'noteOff',note:69,velocity:0,channel:0},releaseTime);
    const result=await Promise.race([completed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Raw audio capture did not complete')),20000))]);
    const arrayFields=Object.fromEntries(['audio','reference','audioBlockLengths','referenceBlockLengths','sampleOffsets','clockEntries','clockExits'].map(key=>[key,Array.from(result[key])]));
    return {...result,...arrayFields,referenceSource:{sampleRate:referenceBuffer.sampleRate,length:referenceBuffer.length,playbackRate:referenceSource.playbackRate.value,detune:referenceSource.detune.value},sampleRate:context.sampleRate,releaseTime,timestamps,errors,baseLatency:context.baseLatency,outputLatency:context.outputLatency};
  } finally {clearInterval(timer);try{referenceSource.stop();}catch{}referenceSource.disconnect();node.dispose();capture.disconnect();await context.close();}
};
