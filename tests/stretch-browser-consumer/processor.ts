import {audioOutput,CAPACITY_16,defineProcessor,event,f32,f64,forSample,i32,instantiate,param,select,state} from '@unworklet/core';
import {residentSample} from '@denaudio/den/sample';
import {residentTimeStretch} from '@denaudio/den/resident-time-stretch';
export const makeProcessor=(capacity:number,sourceSampleRate:number)=>defineProcessor(({sampleRate})=>{
 const sample=instantiate(residentSample,{capacity,sourceSampleRate},{name:'resident'});
 event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:capacity*4}).onReceive(({data})=>sample.load(data));
 const stretch=instantiate(residentTimeStretch,{sampleRate,sample,hopSamples:128,searchFrames:8},{name:'stretch'});
 const gate=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('gate');
 const trigger=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('trigger');
 const reset=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('reset');
 const duration=param.f32({default:1,min:.5,max:2,automationRate:'a-rate'}).named('duration');
 const pitch=param.f32({default:1,min:.5,max:2,automationRate:'a-rate'}).named('pitch');
 const previousTrigger=state.bool(false).named('previousTrigger');
 const count=state.i32(0).named('activeCount'),clock=state.i32(0).named('clock'),startAt=state.i32(0).named('startAt'),eofAt=state.i32(0).named('eofAt');
 const sum=state.f64(0).named('absoluteAudioSum'),previousEnded=state.bool(false).named('previousEnded');
 const output=audioOutput({name:'main',channels:10});
 return{process(){forSample((i,everyNSamples)=>{
  const clear=reset.at(i).gte(.5),t=trigger.at(i).gte(.5),edge=t.and(previousTrigger.read().not());previousTrigger.write(t.and(clear.not()));
  const r=stretch.tick({gate:gate.at(i).gte(.5),trigger:edge,reset:clear,durationScale:duration.at(i),pitchRatio:pitch.at(i)},everyNSamples);
  const launch=r.active.and(r.position.eq(0));
  clock.write(select(clear,i32(0),clock.read()));startAt.write(select(clear,i32(0),select(launch,clock.read(),startAt.read())));
  eofAt.write(select(clear,i32(0),select(r.ended.and(previousEnded.read().not()),clock.read(),eofAt.read())));
  count.write(select(clear,i32(0),select(launch,i32(1),count.read().add(i32(r.active)))));
  sum.write(select(clear,f64(0),select(launch,f64(0),sum.read()).add(f64(r.output).abs())));
  previousEnded.write(r.ended);clock.write(clock.read().add(1));
  [r.output,r.position,f32(r.active),f32(r.ended),f32(r.missing),f32(r.rejected),f32(count.read()),f32(sum.read()),select(r.ended,f32(eofAt.read().sub(startAt.read())),f32(0)),f32(sample.length())].forEach((v,ch)=>output.ch(ch).at(i).write(v));
 });}};
});
export default makeProcessor(65536,48000);
