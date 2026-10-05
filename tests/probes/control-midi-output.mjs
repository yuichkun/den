import assert from 'node:assert/strict';
import { audioOutput, defineProcessor, event, forSample, state } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
const processor = defineProcessor(() => {
  const midi = event.midi({ to: 'main', name: 'notes' });
  const out = audioOutput({channels:1,name:'main'});
  const count = state.i32(0).named('count');
  return {process(){forSample(i=>{
    midi.emitIf(count.read().eq(127),{type:'noteOn',channel:0,note:60,velocity:100,atSample:count.read()});
    midi.emitIf(count.read().eq(128),{type:'noteOff',channel:0,note:60,velocity:0,atSample:count.read()});
    out.ch(0).at(i).write(0);
    count.write(count.read().add(1));
  });}};
});
for(const sampleRate of [44100,48000,96000]) {
  const result=await renderOffline(processor,{sampleRate,duration:256/sampleRate});
  assert.deepEqual(result.events.map(({name,payload,atSample})=>({name,payload,atSample})),[
    {name:'notes',payload:{type:'noteOn',channel:0,note:60,velocity:100},atSample:127},
    {name:'notes',payload:{type:'noteOff',channel:0,note:60,velocity:0},atSample:128},
  ]);
  assert.equal(result.diagnostics.scrubbedSamples,0);
  console.log(JSON.stringify({sampleRate,events:result.events,status:'CANDIDATE',limitation:'Native offline emitted-event path only; browser bridge, WebMIDI device and host delivery unverified.'}));
}
