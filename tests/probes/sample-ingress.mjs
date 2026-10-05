import assert from 'node:assert/strict';
import { audioOutput, defineProcessor, event, forSample, state, select, f32 } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
const processor=defineProcessor(()=>{
 const pcm=state.buffer.f32({size:8}).expose({name:'pcm',snapshot:'persistent'});
 const size=state.i32(0).named('size');
 const ingress=event({from:'main',name:'pcm',payloadCapacity:128});
 ingress.onReceive(({data})=>{pcm.copyFrom(data);size.write(data.length);});
 const out=audioOutput({channels:2,name:'main'});
 return {process(){forSample(i=>{out.ch(0).at(i).write(select(i.lt(size.read()).and(i.lt(8)),pcm.read(i.clamp(0,7)),f32(0)));out.ch(1).at(i).write(f32(size.read()));});}};
});
for(const rate of [44100,48000,96000]) {
 const r=await renderOffline(processor,{sampleRate:rate,duration:127.75/rate,messages:[{name:'pcm',payload:{data:Float32Array.from([1,.5,-.25,0])}}]});
 assert.deepEqual([...r.outputs.main[0].slice(0,8)],[1,.5,-.25,0,0,0,0,0]);
 assert.equal(r.outputs.main[1][0],4); assert.equal(r.diagnostics.scrubbedSamples,0);
 const rest=await renderOffline(processor,{sampleRate:rate,duration:127.75/rate,restore:r.state});
 assert.deepEqual(rest.outputs.main,r.outputs.main);
 console.log({rate,frames:r.outputs.main[0].length,snapshotBytes:r.state.byteLength,ingress:'public event<Float32Array> → copyFrom → persistent fixed buffer',status:'PASS'});
}
