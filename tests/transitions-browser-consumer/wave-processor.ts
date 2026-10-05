import {audioOutput,CAPACITY_16,defineProcessor,event,f32,forSample,instantiate,param} from '@unworklet/core';
import {residentSample} from '@denaudio/den/sample';
import {bandedWavetableSource} from '@denaudio/den/wavetable';
export default defineProcessor(({sampleRate})=>{
 const asset=instantiate(residentSample,{capacity:640,sourceSampleRate:48000},{name:'asset'});
 event<{data:Float32Array}>({from:'main',name:'load',capacity:CAPACITY_16,payloadCapacity:2560}).onReceive(({data})=>asset.load(data));
 const table=instantiate(bandedWavetableSource,{sampleRate,sample:asset,frameLength:64,frameCount:2},{name:'table'});
 const frequency=param.f32({default:375,min:0,max:21600,automationRate:'a-rate'}).named('frequency');
 const frame=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('frame');
 const reset=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('reset');
 const output=audioOutput({name:'main',channels:2});
 return{process(){forSample(i=>{const r=table.tick({frequencyHz:frequency.at(i),frame:frame.at(i),reset:reset.at(i).gte(.5)});output.ch(0).at(i).write(r.output);output.ch(1).at(i).write(f32(r.missing));});}};
});
