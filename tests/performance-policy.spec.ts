import { expect,test } from 'vitest';
import { inspect,type MidiEvent } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import type { PerformancePolicyConfig } from '../src/performance.js';
import { performanceFixture } from './fixtures/performance-fixture.js';
import { PerformanceReference } from './fixtures/performance-reference.js';
type Step={midi?:MidiEvent[];reset?:boolean;finish?:number[]};
const on=(note:number,velocity=127,channel=0):MidiEvent=>({type:'noteOn',note,velocity,channel});
const off=(note:number,channel=0):MidiEvent=>({type:'noteOff',note,velocity:0,channel});
const cc=(controller:number,value=0,channel=0):MidiEvent=>({type:'cc',controller,value,channel});
const bend=(value:number,channel=0):MidiEvent=>({type:'pitchBend',value,channel});
const pressure=(pressure:number,channel=0):MidiEvent=>({type:'channelPressure',pressure,channel});
const poly=(note:number,pressure:number,channel=0):MidiEvent=>({type:'aftertouch',note,pressure,channel});
const config={mode:'poly',capacity:2,heldCapacity:8} as const;
async function trace(setup:PerformancePolicyConfig,steps:Step[],rate=48000){
  const result=await renderOffline(performanceFixture(setup),{sampleRate:rate,duration:(steps.length*128-.25)/rate,
    events:steps.flatMap((s,q)=>(s.midi??[]).map(payload=>({name:'midi',payload,atSample:q*128}))),
    messages:steps.flatMap((s,q)=>[...(s.reset?[{name:'reset',payload:{value:1},atQuantum:q}]:[]),...(s.finish??[]).map(slot=>({name:'finish',payload:{slot},atQuantum:q}))]),
  });
  expect(result.diagnostics.scrubbedSamples).toBe(0);expect(Object.keys(inspect(result.state).slots)).toEqual([]);
  const reference=new PerformanceReference(setup);
  const frames=steps.map((s,q)=>{
    for(const slot of s.finish??[])reference.finish(slot);
    for(const e of s.midi??[])reference.event(e);
    if(s.reset)reference.reset();
    const expected=reference.frame();
    const actual=Object.fromEntries(Object.entries(result.outputs).map(([name,channels])=>[name,channels.map(c=>c[q*128])]));
    for(const [name,values]of Object.entries(expected))values.forEach((value,ch)=>expect(actual[name][ch],`${name}, q=${q}, ch=${ch}`).toBeCloseTo(value,6));
    expect(result.outputs.trigger.every(c=>c.slice(q*128+1,(q+1)*128).every(x=>x===0))).toBe(true);
    expect(result.outputs.clear.every(c=>c.slice(q*128+1,(q+1)*128).every(x=>x===0))).toBe(true);
    return actual;
  });
  return {result,frames};
}
for(const rate of [44100,48000,96000]) {
  test(`sustain FIFO duplicates, stolen identities, new physical keys and pedal flush ${rate}`,async()=>{
    const {frames:f}=await trace(config,[
      {midi:[cc(64,127),on(60,30),on(60,80)]},{midi:[off(60)]},{midi:[on(60,120)]},{midi:[off(60)]},
      {midi:[cc(64,0)]},{midi:[off(60)]},{finish:[0,1]},
    ],rate);
    expect(f[4].gate).toEqual([1,0]);expect(f[4].velocity[0]).toBeCloseTo(120/127,6);
    expect(f[5].gate).toEqual([0,0]);expect(f[6].active).toEqual([0,0]);
  });
  test(`CC120 channel panic and CC121 local expression/pedal reset ${rate}`,async()=>{
    await trace(config,[
      {midi:[on(60,127,0),on(64,127,1),cc(64,127,0),cc(64,127,1),bend(0,0),bend(16383,1),pressure(63,0),pressure(127,1),cc(74,42,0),cc(74,91,1),poly(60,75,0),poly(64,33,1)]},
      {midi:[off(60,0),off(64,1)]},{midi:[cc(121,0,0)]},{midi:[cc(120,0,1),on(69,100,1)]},
      {midi:[cc(123,0,1)]},{finish:[0,1]},
    ],rate);
  });
  test(`native pressure, asymmetric bend endpoints, all notes off under held pedal ${rate}`,async()=>{
    const {frames:f}=await trace(config,[
      {midi:[poly(60,127),on(60,10),on(60,100),poly(60,64),pressure(127),bend(8192),cc(74,127)]},
      {midi:[cc(64,127),cc(123)]},{midi:[bend(16383)]},{midi:[bend(0)]},{midi:[cc(64,63)]},{finish:[0,1]},
      {midi:[on(60),bend(8191),pressure(0),cc(74,0)]},{midi:[bend(8193)]},
    ],rate);
    expect(f[1].gate).toEqual([1,1]);expect(f[4].gate).toEqual([0,0]);expect(f[0].polyPressure[0]).toBeCloseTo(64/127,6);
    expect(f[6].bend[0]).toBe(-1/8192);expect(f[7].bend[0]).toBeCloseTo(1/8191,7);
  });
  test(`mono legato, pedal priority/fallback, retrigger and panic ${rate}`,async()=>{
    for(const legato of [true,false])await trace({mode:'mono',heldCapacity:4,legato},[
      {midi:[on(60),cc(64,127)]},{midi:[on(64),off(64)]},{midi:[on(67),off(67)]},{midi:[cc(64,0)]},
      {midi:[off(60)]},{midi:[on(72)],reset:true},{midi:[off(72)]},{midi:[on(69)]},
    ],rate);
  });
  test(`bounded overflow retains accepted ledger through steal, CC and repeated reuse ${rate}`,async()=>{
    await trace({mode:'poly',capacity:2,heldCapacity:2},[
      {midi:[cc(64,127),on(60),on(64)]},{midi:[off(60),on(67)]},{midi:[off(67)]},{midi:[cc(64,0)]},
      {midi:[on(69),off(64),off(69)]},{finish:[0,1]},{reset:true},{midi:[on(60),off(60)]},{finish:[0]},
    ],rate);
  });
  test(`performance snapshots exclude live notes, pedal and expression ${rate}`,async()=>{
    const {result}=await trace(config,[{midi:[on(60),cc(64,127),off(60),pressure(127),bend(0)]}],rate);
    const clean=await renderOffline(performanceFixture(config),{sampleRate:rate,duration:(128-.25)/rate,restore:result.state});
    expect(clean.outputs.active.every(c=>c.every(x=>x===0))).toBe(true);
    for(const field of ['gate','channelPressure','polyPressure','bend','timbre','sustain','overflow'])expect(clean.outputs[field].every(c=>c.every(x=>x===0))).toBe(true);
  });
}

test('seeded independent event-property oracle at declared capacity, two modes',async()=>{
  for(const mode of ['mono','poly'] as const){
    let seed=1984;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
    const steps:Step[]=[];
    for(let q=0;q<90;q++){
      const midi:MidiEvent[]=[];
      for(let n=0;n<1+(random()%4);n++){
        const kind=random()%9,ch=random()%2,note=60+random()%4;
        midi.push(kind<3?on(note,1+random()%127,ch):kind<5?off(note,ch):kind===5?cc(64,random()%128,ch):kind===6?cc([120,121,123][random()%3],0,ch):kind===7?poly(note,random()%128,ch):bend(random()%16384,ch));
      }
      steps.push({midi,reset:q%29===28,finish:q%7===6?[0,1,2,3]:[]});
    }
    steps.push({reset:true});
    await trace({mode,capacity:mode==='mono'?1:4,heldCapacity:8},steps);
  }
});
test('construction rejects invalid performance capacities/modes',()=>{
  for(const invalid of [{...config,capacity:5},{...config,heldCapacity:9},{...config,heldCapacity:1},{...config,capacity:1.5},{...config,mode:'other'},{mode:'mono',capacity:2}])expect(()=>performanceFixture(invalid as PerformancePolicyConfig)).toThrow();
});

test('stolen/deferred same-key identity and newer physical identity, both pedal/off orders',async()=>{
  for(const final of [[cc(64,0),off(60)],[off(60),cc(64,0)]]){
    const {frames}=await trace({mode:'poly',capacity:1,heldCapacity:4},[
      {midi:[cc(64,127),on(60,30),off(60)]},{midi:[on(60,100)]},{midi:[final[0]]},{midi:[final[1]]},{finish:[0]},
    ]);
    expect(frames[2].gate).toEqual([1]);expect(frames[3].gate).toEqual([0]);expect(frames[4].active).toEqual([0]);
  }
});
test('CC120 mono fallback resets physical slot, CC121/new-note FIFO ordering',async()=>{
  const {frames}=await trace({mode:'mono',heldCapacity:8},[
    {midi:[on(60,70,0),on(64,80,1)]},{midi:[cc(120,0,1)]},
    {midi:[cc(64,127,0),off(60,0),cc(121,0,0),on(60,100,0)]},
    {midi:[cc(64,127,0),off(60,0),on(60,120,0),cc(121,0,0)]},{midi:[off(60,0)]},
  ]);
  expect(frames[1].note).toEqual([60]);expect(frames[1].clear).toEqual([1]);
  expect(frames[2].gate).toEqual([1]);expect(frames[3].gate).toEqual([1]);expect(frames[4].gate).toEqual([0]);
});

test('mono identical-key legato owner changes clear poly pressure without retrigger',async()=>{
  const {frames}=await trace({mode:'mono',heldCapacity:4,legato:true},[
    {midi:[on(60),poly(60,127)]},{midi:[on(60)]},{midi:[poly(60,80)]},
    {midi:[off(60)]},{midi:[on(60,64),poly(60,100)]},{midi:[cc(64,127),off(60),off(60)]},{midi:[cc(64,0)]},
  ]);
  expect(frames[1].polyPressure).toEqual([0]);expect(frames[1].trigger).toEqual([0]);
  expect(frames[3].polyPressure[0]).toBeCloseTo(80/127,6);
});
