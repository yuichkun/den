import { audioOutput, defineProcessor, f32, forSample, instantiate, param } from '@unworklet/core';
import { oscillator } from '@denaudio/den/oscillator';
import { oversampledDrive } from '@denaudio/den/oversampled-drive';
import { dualHeadDelay } from '@denaudio/den/dual-head-delay';
import { windowedPitchShift } from '@denaudio/den/windowed-pitch-shift';
import { stftIdentity } from '@denaudio/den/spectral';
export default defineProcessor(({sampleRate})=>{
 const source=instantiate(oscillator,{sampleRate,waveform:'sine'},{name:'source'});
 const drive=instantiate(oversampledDrive,{sampleRate,factor:2,curve:'hard'},{name:'drive'});
 const delay=instantiate(dualHeadDelay,{sampleRate,maxDelaySeconds:.01,transitionSamples:32},{name:'delay'});
 const pitch=instantiate(windowedPitchShift,{sampleRate,windowSamples:2048},{name:'pitch'});
 const spectral=instantiate(stftIdentity,{size:256,hopSize:128},{name:'spectral'});
 const ratio=param.f32({default:1,min:.5,max:2,automationRate:'a-rate'}).named('ratio');
 const time=param.f32({default:8/sampleRate,min:1/sampleRate,max:.01,automationRate:'a-rate'}).named('time');
 const gain=param.f32({default:1,min:0,max:32,automationRate:'a-rate'}).named('gain');
 const mix=param.f32({default:1,min:0,max:1,automationRate:'a-rate'}).named('mix');
 const reset=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('reset');
 const out=audioOutput({name:'main',channels:10});
 return{process(){forSample((i,everyNSamples)=>{
  const clear=reset.at(i).gte(.5),x=source.tick(f32(375),clear).mul(.125);
  const d=drive.tick(x,gain.at(i),mix.at(i),clear);
  const t=delay.tick(x,time.at(i),clear).output;
  const p=pitch.tick(x,{ratio:ratio.at(i),retrigger:clear,reset:clear}).output;
  const s=spectral.tick(x,clear,everyNSamples);
  [x,d,t,p,s,ratio.at(i),time.at(i),gain.at(i),mix.at(i),reset.at(i)].forEach((value,ch)=>out.ch(ch).at(i).write(value));
 });}};
});
