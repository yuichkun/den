import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { gate } from '@denaudio/den/gate';
import { renderOffline, encodeWav } from '@unworklet/offline';
import { composed, voiceContract } from './contract.ts';
import { inspect } from '@unworklet/core';
for (const sampleRate of [44100, 48000, 96000]) {
  const voice = await renderOffline(voiceContract, {sampleRate,duration:(256-.5)/sampleRate,events:[
    {name:'midi',atSample:0,payload:{type:'noteOn',note:60,velocity:100,channel:0}},
    {name:'midi',atSample:128,payload:{type:'noteOff',note:60,velocity:0,channel:0}},
  ]});
  assert.equal(voice.outputs.main[0].length,256);
  assert.equal(voice.diagnostics.scrubbedSamples,0);
  assert(voice.outputs.main[0].slice(0,128).every(x=>x===1));
  assert(voice.outputs.main[0].slice(128).every(x=>x===0));
  const composedResult = await renderOffline(composed,{sampleRate,duration:128/sampleRate});
  assert.equal(composedResult.outputs.main[0][0],0);
  assert(composedResult.outputs.main[0].slice(1).every(x=>x===0.5));
  const input = Float32Array.from({length: 256}, (_, i) => (i + 1) / 256);
  const result = await renderOffline(gate, {sampleRate, duration: 256/sampleRate, inputs:{main:[input]}, params:{gain:[0.5]}});
  assert.equal(result.outputs.main[0].length,256);
  assert.equal(result.diagnostics.scrubbedSamples,0);
  assert.equal(result.outputs.main[0][0],0);
  for(let i=1;i<256;i++) assert.equal(result.outputs.main[0][i],input[i-1]*0.5);
  const restored = await renderOffline(gate, {sampleRate,duration:128/sampleRate,restore:result.state});
  assert.equal(restored.outputs.main[0][0],0.5);
  assert(restored.outputs.main[0].slice(1).every(x=>x===0));
  const fresh = await renderOffline(gate, {sampleRate,duration:128/sampleRate});
  assert(fresh.outputs.main[0].every(x=>x===0));
  writeFileSync(`candidate-${sampleRate}.wav`,encodeWav(result.outputs.main,sampleRate));
  const points=Array.from(result.outputs.main[0],(value,i)=>`${40+i*2},${180-value*280}`).join(' ');
  writeFileSync(`candidate-${sampleRate}.svg`,`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="230" viewBox="0 0 600 230"><rect width="600" height="230" fill="white"/><text x="40" y="20">CANDIDATE: gate, ${sampleRate} Hz, gain 0.5</text><path d="M40 40V180H552" stroke="black" fill="none"/><text x="8" y="45">0.5</text><text x="20" y="185">0</text><text x="40" y="205">0</text><text x="460" y="205">255 samples</text><polyline points="${points}" fill="none" stroke="#2358b0" stroke-width="2"/></svg>`);
  writeFileSync(`snapshot-${sampleRate}.json`,JSON.stringify(inspect(result.state),null,2));
}
console.log('Packed consumer: numerical render and same-schema snapshot continuation passed at 44.1/48/96 kHz');
