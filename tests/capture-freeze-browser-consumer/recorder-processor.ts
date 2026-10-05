import {audioOutput,bool,CAPACITY_16,defineProcessor,event,f32,f64,forSample,i32,instantiate,param} from '@unworklet/core';
import {residentTakeRecorder} from '@denaudio/den/resident-recorder';
import {samplePlayer} from '@denaudio/den/sample';
export default defineProcessor(({sampleRate})=>{
 const take=instantiate(residentTakeRecorder,{capacity:256,sampleRate},{name:'take'});
 const player=instantiate(samplePlayer,{sampleRate,sample:take.sample,loop:true,releaseFrames:0},{name:'player'});
 event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:16}).onReceive(({data})=>take.sample.load(data));
 const input=param.f32({default:.25,min:-1,max:1,automationRate:'a-rate'}).named('input');
 const record=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('record');
 const limit=param.f32({default:64,min:0,max:512,automationRate:'a-rate'}).named('limit');
 const reset=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('reset');
 const position=param.f32({default:0,min:0,max:255,automationRate:'a-rate'}).named('position');
 const play=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('play');
 const output=audioOutput({name:'main',channels:7});
 return{process(){forSample(i=>{
  const clear=reset.at(i).gte(.5);
  // A native composition limit makes partial captures deterministic without
  // relying on host timers. A limit above capacity still tests the hard stop.
  const r=take.tick({input:input.at(i),record:record.at(i).gte(.5).and(f32(take.sample.length()).lt(limit.at(i))),reset:clear});
  const first=take.sample.read(f64(0),i32(0),i32(256),false),last=take.sample.read(f64(r.length.sub(1)),i32(0),i32(256),false),query=take.sample.read(f64(position.at(i)),i32(0),i32(256),false);
  const playback=player.tick({gate:play.at(i).gte(.5),trigger:bool(false),reset:clear,rate:f32(1)}).output;
  [f32(r.length),first,last,query,f32(r.written),f32(r.full),playback].forEach((v,ch)=>output.ch(ch).at(i).write(v));
 });}};
});
