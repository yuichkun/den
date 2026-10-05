import assert from 'node:assert/strict';
import { audioOutput, defineProcessor, event, f32, forSample, state, inspect } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
const processor = defineProcessor(() => {
  const midi = event.midi({from:'main',name:'midi'}), out=audioOutput({name:'main',channels:6});
  const values=state.buffer.i32({size:6}).expose({name:'values',snapshot:'transient'});
  midi.onEvent('channelPressure',e=>{values.write(0,e.channel);values.write(1,e.pressure);});
  midi.onEvent('aftertouch',e=>{values.write(2,e.note);values.write(3,e.pressure);});
  midi.onEvent('pitchBend',e=>values.write(4,e.value));
  midi.onEvent('cc',e=>values.write(5,e.value));
  return {process(){forSample(i=>{for(let c=0;c<6;c++)out.ch(c).at(i).write(f32(values.read(c)));});}};
});
for(const sampleRate of [44100,48000,96000]) {
 const events=[
  {name:'midi',atSample:0,payload:{type:'channelPressure',channel:15,pressure:127}},
  {name:'midi',atSample:0,payload:{type:'aftertouch',channel:15,note:69,pressure:93}},
  {name:'midi',atSample:0,payload:{type:'pitchBend',channel:15,value:16383}},
  {name:'midi',atSample:0,payload:{type:'cc',channel:15,controller:74,value:71}},
  {name:'midi',atSample:129,payload:{type:'pitchBend',channel:15,value:0}},
 ];
 const result=await renderOffline(processor,{sampleRate,duration:(384-.25)/sampleRate,events});
 assert.deepEqual(result.outputs.main.map(x=>x[0]),[15,127,69,93,16383,71]);
 assert.equal(result.diagnostics.scrubbedSamples,0);
 assert.equal(result.outputs.main[4][127],16383);
 const change=result.outputs.main[4].findIndex(x=>x===0);
 assert.equal(change,128); // 0.4.1 drains MIDI scheduled within a block before that block.
 assert.deepEqual(Object.keys(inspect(result.state).slots),[]);
 const restored=await renderOffline(processor,{sampleRate,duration:(128-.25)/sampleRate,restore:result.state});
 assert(restored.outputs.main.every(ch=>ch.every(x=>x===0)));
 console.log(JSON.stringify({sampleRate,status:'native receiver entry passed',scheduledSample:129,observedBoundary:change,scrubbedSamples:0,snapshotSlots:0}));
}
