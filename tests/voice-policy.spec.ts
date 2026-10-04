import { test, expect } from 'vitest';
import { audioOutput, defineProcessor, event, f32, i32, forSample, instantiate, inspect, type MidiEvent } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { expectMidiBalance } from '@unworklet/test';
import { voicePolicy, type VoicePolicyConfig } from '../src/voice-policy.js';

type Step = { midi?: MidiEvent[]; reset?: boolean; finish?: number[] };
const on = (note: number, velocity = 127, channel = 0): MidiEvent => ({type:'noteOn',note,velocity,channel});
const off = (note: number, channel = 0): MidiEvent => ({type:'noteOff',note,velocity:0,channel});
const cc = (controller: number, channel = 0): MidiEvent => ({type:'cc',controller,value:0,channel});
const processors = new Map<string, ReturnType<typeof defineProcessor>>();
function fixture(config: VoicePolicyConfig) {
  const key = JSON.stringify(config);
  let processor = processors.get(key);
  if (!processor) {
    processor = defineProcessor(() => {
      const policy = instantiate(voicePolicy, config, {name:'voices'});
      policy.bindMidi(event.midi({from:'main',name:'midi'}));
      event<{value:number}>({from:'main',name:'reset'}).onReceive(() => policy.reset());
      event<{slot:number}>({from:'main',name:'finish'}).onReceive(p => {
        policy.voices.forEach((voice,index) => voice.releaseFinished(p.slot.eq(index)));
      });
      const out = Object.fromEntries(['note','channel','velocity','active','gate','trigger'].map(name=>[name,audioOutput({name,channels:policy.capacity})]));
      const overflow = audioOutput({name:'overflow',channels:1});
      return {process() { forSample(i => {
        policy.voices.forEach((voice,index) => {
          const v = voice.read();
          out.note.ch(index).at(i).write(f32(v.note));
          out.channel.ch(index).at(i).write(f32(v.channel));
          out.velocity.ch(index).at(i).write(v.velocity);
          out.active.ch(index).at(i).write(f32(v.active));
          out.gate.ch(index).at(i).write(f32(v.gate));
          out.trigger.ch(index).at(i).write(f32(voice.takeRetrigger()));
        });
        overflow.ch(0).at(i).write(f32(policy.overflowed()));
      }); }};
    });
    processors.set(key,processor);
  }
  return processor;
}
async function trace(config: VoicePolicyConfig, steps: Step[], sampleRate = 48000) {
  const result = await renderOffline(fixture(config), {
    sampleRate,
    // Stay inside the final quantum to avoid upstream #96's floating boundary overrun.
    duration: (steps.length * 128 - 0.5) / sampleRate,
    events: steps.flatMap((s,q)=>(s.midi??[]).map(payload=>({name:'midi',payload,atSample:q*128}))),
    messages: steps.flatMap((s,q)=>[
      ...(s.reset?[{name:'reset',payload:{value:1},atQuantum:q}]:[]),
      ...(s.finish??[]).map(slot=>({name:'finish',payload:{slot},atQuantum:q})),
    ]),
  });
  expect(result.outputs.note[0].length).toBe(steps.length*128);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  const frames = steps.map((_,q)=>Object.fromEntries(Object.entries(result.outputs).map(([name,channels])=>[name,channels.map(c=>c[q*128])])));
  return {frames, result};
}
const poly = {mode:'poly',capacity:2,heldCapacity:8} as const;
const mono = {mode:'mono',heldCapacity:8} as const;

test('poly allocation, channel-aware FIFO duplicates, velocity zero and release completion', async()=>{
  const {frames:f,result} = await trace(poly,[
    {midi:[on(60,64),on(60,127)]},
    {midi:[off(60,1)]},
    {midi:[on(60,0)]},
    {finish:[0]},
    {midi:[off(60)]},
    {finish:[1]},
  ]);
  expect(f.map(v=>v.note)).toEqual([[60,60],[60,60],[60,60],[-1,60],[-1,60],[-1,-1]]);
  expect(f.map(v=>v.gate)).toEqual([[1,1],[1,1],[0,1],[0,1],[0,0],[0,0]]);
  expect(f[0].velocity[0]).toBeCloseTo(64/127,7);
  expect(f[0].trigger).toEqual([1,1]);
  expect(result.outputs.trigger.every(c=>c.slice(1).every(x=>x===0))).toBe(true);
  expect(Object.keys(inspect(result.state).slots)).toEqual([]);
});

test('stolen identities consume their own note-off without releasing a newer duplicate', async()=>{
  const {frames:f} = await trace({...poly,capacity:1},[
    {midi:[on(60,20)]}, {midi:[on(60,100)]}, {midi:[off(60)]},
    {midi:[off(60)]}, {finish:[0]},
  ]);
  expect(f.map(v=>v.gate)).toEqual([[1],[1],[1],[0],[0]]);
  expect(f.map(v=>v.note)).toEqual([[60],[60],[60],[60],[-1]]);
  expect(f.map(v=>v.trigger)).toEqual([[1],[1],[0],[0],[0]]);
});

test('mono last-held priority and legato fallback survive out-of-order releases', async()=>{
  const {frames:f} = await trace(mono,[
    {midi:[on(60,40)]}, {midi:[on(64,80)]}, {midi:[on(67,120)]},
    {midi:[off(64)]}, {midi:[off(67)]}, {midi:[off(60)]}, {finish:[0]},
  ]);
  expect(f.map(v=>v.note)).toEqual([[60],[64],[67],[67],[60],[60],[-1]]);
  expect(f.map(v=>v.trigger)).toEqual([[1],[0],[0],[0],[0],[0],[0]]);
  expect(f.map(v=>v.gate)).toEqual([[1],[1],[1],[1],[1],[0],[0]]);
  expect(f[4].velocity[0]).toBeCloseTo(40/127,7);
});

test('reproduce upstream #99 instead of trusting the MIDI-balance helper',()=>{
  const result={outputs:{},sampleRate:48000,state:new Uint8Array(),events:[on(60),on(60,0)].map(payload=>({name:'midi',atSample:0,payload}))};
  expect(()=>expectMidiBalance(result,'midi')).toThrow(/hanging/);
});

test('reuse oldest release before held voices; choose lowest free slot after completion', async()=>{
  const {frames:f} = await trace(poly,[
    {midi:[on(60),on(62)]}, {midi:[off(62)]}, {midi:[off(60)]},
    {midi:[on(64)]}, {finish:[0,1]}, {midi:[on(65)]},
  ]);
  expect(f.map(v=>v.note)).toEqual([[60,62],[60,62],[60,62],[60,64],[-1,64],[65,64]]);
  expect(f.map(v=>v.gate)).toEqual([[1,1],[1,0],[0,0],[0,1],[0,1],[1,1]]);
  // Finishing a former release must not free its newly held replacement.
  expect(f[4].active).toEqual([0,1]);
});

test('oldest held voice is stolen repeatedly without stale note-offs or counter drift', async()=>{
  const {frames:f} = await trace(poly,[
    {midi:[on(60),on(61)]}, {midi:[on(62)]}, {midi:[on(63)]},
    {midi:[off(60),off(61)]}, {midi:[off(62),off(63)]}, {finish:[0,1]},
  ]);
  expect(f.map(v=>v.note)).toEqual([[60,61],[62,61],[62,63],[62,63],[62,63],[-1,-1]]);
  expect(f[3].gate).toEqual([1,1]);
  expect(f[4].gate).toEqual([0,0]);
});

test('mono retrigger mode retriggers changes and fallbacks, not irrelevant releases', async()=>{
  const {frames:f} = await trace({...mono,legato:false},[
    {midi:[on(60)]}, {midi:[on(64)]}, {midi:[off(70)]},
    {midi:[off(64)]}, {midi:[off(60)]}, {midi:[on(67)]},
  ]);
  expect(f.map(v=>v.note)).toEqual([[60],[64],[64],[60],[60],[67]]);
  expect(f.map(v=>v.trigger)).toEqual([[1],[1],[0],[1],[0],[1]]);
});

test('mono duplicate identities retain latest velocity and channel until FIFO release', async()=>{
  const {frames:f} = await trace(mono,[
    {midi:[on(60,20,0)]}, {midi:[on(64,70,1)]}, {midi:[on(60,100,0)]},
    {midi:[off(60,0)]}, {midi:[off(60,0)]}, {midi:[off(64,1)]},
  ]);
  expect(f.map(v=>v.note)).toEqual([[60],[64],[60],[60],[64],[64]]);
  expect(f.map(v=>v.channel)).toEqual([[0],[1],[0],[0],[1],[1]]);
  expect(f[3].velocity[0]).toBeCloseTo(100/127,7);
  expect(f[4].velocity[0]).toBeCloseTo(70/127,7);
  expect(f[5].gate).toEqual([0]);
});

test.each(['mono','poly'] as const)('%s all-notes-off releases; all-sound-off clears only its channel',async(mode)=>{
  const config={mode,capacity:mode==='mono'?1:2,heldCapacity:8};
  const {frames:f}=await trace(config,[
    {midi:[on(60,127,0),on(64,127,1)]}, {midi:[cc(64,1)]},
    {midi:[cc(123,1)]}, {midi:[cc(120,0)]}, {midi:[cc(120,1)]},
  ]);
  expect(f[1].note).toEqual(f[0].note); // sustain is deliberately not implemented
  if(mode==='mono') {
    expect(f[2].note).toEqual([60]); expect(f[2].gate).toEqual([1]);
    expect(f[3].active).toEqual([0]);
  } else {
    expect(f[2].gate).toEqual([1,0]); expect(f[3].active).toEqual([0,1]);
  }
  expect(f[4].active.every(x=>x===0)).toBe(true);
});

test.each(['mono','poly'] as const)('%s held-capacity overflow rejects new notes, remains releasable, and reset clears it',async(mode)=>{
  const {frames:f}=await trace({mode,capacity:mode==='mono'?1:2,heldCapacity:2},[
    {midi:[on(60),on(64)]}, {midi:[on(67)]}, {midi:[off(67)]},
    {midi:[off(60),off(64)]}, {finish:[0,1]}, {reset:true}, {midi:[on(69)]},
  ]);
  expect(f[1].note).toEqual(f[0].note);
  expect(f.map(v=>v.overflow)).toEqual([[0],[1],[1],[1],[1],[0],[0]]);
  expect(f[3].gate.every(x=>x===0)).toBe(true);
  expect(f[4].active.every(x=>x===0)).toBe(true);
  expect(f[6].note[0]).toBe(69);
});

test.each([44100,48000,96000])('reset clears held and releasing state and permits fresh notes at %i Hz',async(sampleRate)=>{
  const {frames:f}=await trace(poly,[
    {midi:[on(0,1,15),on(127,127,0)]}, {midi:[off(0,15)]},
    {reset:true}, {midi:[off(127,0)]}, {midi:[on(65)]},
  ],sampleRate);
  expect(f[0].note).toEqual([0,127]);
  expect(f[2].note).toEqual([-1,-1]); expect(f[2].velocity).toEqual([0,0]);
  expect(f[2].trigger).toEqual([0,0]); expect(f[3].active).toEqual([0,0]);
  expect(f[4].note).toEqual([65,-1]); expect(f[4].trigger).toEqual([1,0]);
  const clean=await trace(poly,[{}],sampleRate);
  expect(clean.frames[0].active).toEqual([0,0]);
});

test('long reuse sequence keeps held identities and allocation order bounded',async()=>{
  const steps:Step[]=[];
  for(let n=0;n<80;n++) steps.push({midi:[on(60),on(64),off(60),off(64)],finish:[0,1]});
  steps.push({finish:[0,1]});
  const {frames}=await trace(poly,steps);
  expect(frames.every(v=>v.gate.every(x=>x===0))).toBe(true);
  expect(frames.every(v=>v.overflow[0]===0)).toBe(true);
  expect(frames.at(-1)!.active).toEqual([0,0]);
});

test('two graph instances and fresh renders do not share state',async()=>{
  const proc=defineProcessor(()=>{
    const a=instantiate(voicePolicy,{mode:'mono',heldCapacity:4},{name:'a'});
    const b=instantiate(voicePolicy,{mode:'mono',heldCapacity:4},{name:'b'});
    a.bindMidi(event.midi({from:'main',name:'aMidi'}));
    b.bindMidi(event.midi({from:'main',name:'bMidi'}));
    event<{value:number}>({from:'main',name:'resetA'}).onReceive(()=>a.reset());
    const output=audioOutput({name:'notes',channels:2});
    return {process(){forSample(i=>{
      output.ch(0).at(i).write(f32(a.voices[0].read().note));
      output.ch(1).at(i).write(f32(b.voices[0].read().note));
    });}};
  });
  const result=await renderOffline(proc,{sampleRate:48000,duration:(384-0.5)/48000,
    events:[{name:'aMidi',payload:on(60),atSample:0},{name:'bMidi',payload:on(70),atSample:128}],
    messages:[{name:'resetA',payload:{value:1},atQuantum:2}],
  });
  expect([0,128,256].map(i=>result.outputs.notes.map(c=>c[i]))).toEqual([[60,-1],[60,70],[-1,70]]);
});

test('construction rejects invalid fixed capacities and modes',()=>{
  for(const config of [
    {mode:'poly',capacity:0}, {mode:'poly',capacity:1.5}, {mode:'poly',capacity:33},
    {mode:'poly',capacity:2,heldCapacity:1}, {mode:'poly',heldCapacity:257},
    {mode:'mono',capacity:2}, {mode:'other'}, {mode:'mono',legato:'yes'},
  ]) expect(()=>fixture(config as VoicePolicyConfig)).toThrow();
});

test.each([
  {mode:'poly'} as const,
  {mode:'poly',capacity:32,heldCapacity:256} as const,
])('default and maximum construction capacities render bounded state: %j',async(config)=>{
  const count=config.capacity??16;
  const {frames:f}=await trace(config,[
    {midi:Array.from({length:count},(_,i)=>on(i))},
    {midi:Array.from({length:count},(_,i)=>off(i))},
    {finish:Array.from({length:count},(_,i)=>i)},
  ]);
  expect(f[0].note).toEqual(Array.from({length:count},(_,i)=>i));
  expect(f[1].gate.every(x=>x===0)).toBe(true);
  expect(f[2].active.every(x=>x===0)).toBe(true);
},30000);

test('default voices support per-sample envelope completion wiring',async()=>{
  const processor=defineProcessor(()=>{
    const policy=instantiate(voicePolicy,{mode:'poly'},{name:'voices'});
    policy.bindMidi(event.midi({from:'main',name:'midi'}));
    const output=audioOutput({name:'active',channels:1});
    return {process(){forSample(i=>{
      for(const voice of policy.voices) voice.releaseFinished(voice.read().gate.not());
      output.ch(0).at(i).write(f32(policy.voices[0].read().active));
    });}};
  });
  const result=await renderOffline(processor,{sampleRate:48000,duration:255.5/48000,events:[
    {name:'midi',payload:on(60),atSample:0},{name:'midi',payload:off(60),atSample:128},
  ]});
  expect(result.outputs.active[0][0]).toBe(1);
  expect(result.outputs.active[0][128]).toBe(0);
},30000);

test('graph method validation ignores invalid values without masking them into MIDI range',async()=>{
  const processor=defineProcessor(()=>{
    const policy=instantiate(voicePolicy,{mode:'mono',heldCapacity:4},{name:'voices'});
    event<{note:number;channel:number;velocity:number}>({from:'main',name:'key'}).onReceive(p=>policy.noteOn(i32(p.note),i32(p.channel),i32(p.velocity)));
    const output=audioOutput({name:'note',channels:1});
    return {process(){forSample(i=>output.ch(0).at(i).write(f32(policy.voices[0].read().note)));}};
  });
  const payloads=[
    {note:60,channel:0,velocity:100}, {note:128,channel:0,velocity:100},
    {note:-1,channel:0,velocity:100}, {note:64,channel:16,velocity:100},
    {note:64,channel:-1,velocity:100}, {note:64,channel:0,velocity:128},
    {note:64,channel:0,velocity:-1},
  ];
  const result=await renderOffline(processor,{sampleRate:48000,duration:(payloads.length*128-0.5)/48000,
    messages:payloads.map((payload,atQuantum)=>({name:'key',payload,atQuantum})),
  });
  expect(payloads.map((_,q)=>result.outputs.note[0][q*128])).toEqual(payloads.map(()=>60));
});
