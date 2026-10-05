import {audioOutput,CAPACITY_16,defineProcessor,event,f32,forSample,instantiate,param} from '@unworklet/core';
import {residentSample} from '@denaudio/den/sample';
import {crossfadedLoopPlayer} from '@denaudio/den/loop-crossfade';
export default defineProcessor(({sampleRate})=>{
 const asset=instantiate(residentSample,{capacity:8,sourceSampleRate:48000},{name:'asset'});
 event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:32}).onReceive(({data})=>asset.load(data));
 const loop=instantiate(crossfadedLoopPlayer,{sampleRate,sample:asset,startFrame:0,endFrame:8,crossfadeFrames:2,releaseFrames:4},{name:'loop'});
 const gate=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('gate');
 const rate=param.f32({default:1,min:-16,max:16,automationRate:'a-rate'}).named('rate');
 const trigger=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('trigger');
 const reset=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('reset');
 const output=audioOutput({name:'main',channels:6});
 return{process(){forSample(i=>{const r=loop.tick({gate:gate.at(i).gte(.5),rate:rate.at(i),trigger:trigger.at(i).gte(.5),reset:reset.at(i).gte(.5)});[r.output,r.phase,f32(r.periodFrames),f32(r.crossfadeFrames),f32(r.active),f32(r.missing)].forEach((v,ch)=>output.ch(ch).at(i).write(v));});}};
});
