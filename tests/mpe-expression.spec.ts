import { expect,test } from 'vitest';
import { audioOutput, bool, defineProcessor, event, f32, forSample, i32, inspect, instantiate, wireToMidiEvent } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { mpeExpression,type MpeExpressionConfig } from '../src/mpe-expression.js';
import type { PerformancePolicyConfig } from '../src/performance.js';
import { mpeFixture } from './fixtures/mpe-expression-fixture.js';
import { MpeReference,type MidiBytes } from './fixtures/mpe-expression-reference.js';
type Step={bytes?:MidiBytes[];reset?:'expression'|'all';finish?:number[]};
const on=(note:number,ch=1,velocity=127):MidiBytes=>[0x90+ch,note,velocity];
const off=(note:number,ch=1):MidiBytes=>[0x80+ch,note,0];
const cc=(controller:number,value=0,ch=1):MidiBytes=>[0xb0+ch,controller,value];
const pressure=(value:number,ch=1):MidiBytes=>[0xd0+ch,value,0];
const bend=(value:number,ch=1):MidiBytes=>[0xe0+ch,value&127,value>>7];
const allocation={mode:'poly',capacity:2,heldCapacity:8} as const;
async function trace(steps:Step[],sampleRate=48000,config:MpeExpressionConfig={memberChannels:2},setup:PerformancePolicyConfig=allocation,reverse=false){
  const processor=mpeFixture(config,setup,reverse),reference=new MpeReference(config,setup);
  const result=await renderOffline(processor,{sampleRate,duration:(128*steps.length-.25)/sampleRate,
    events:steps.flatMap((s,q)=>(s.bytes??[]).map(bytes=>({name:'midi',payload:wireToMidiEvent(...bytes),atSample:q*128}))),
    messages:steps.flatMap((s,q)=>[...(s.reset?[{name:'reset',payload:{all:s.reset==='all'?1:0},atQuantum:q}]:[]),...(s.finish??[]).map(slot=>({name:'finish',payload:{slot},atQuantum:q}))]),
  });
  expect(result.diagnostics.scrubbedSamples).toBe(0);expect(Object.keys(inspect(result.state).slots)).toEqual([]);
  const frames=steps.map((s,q)=>{
    for(const n of s.finish??[])reference.policy.finish(n);
    for(const bytes of s.bytes??[])reference.event(bytes);
    if(s.reset)reference.reset(s.reset==='all');
    const expected=reference.frame(),actual=Object.fromEntries(Object.entries(result.outputs).map(([name,channels])=>[name,channels.map(c=>c[q*128])]));
    for(const [name,values]of Object.entries(expected))values.forEach((value,n)=>expect(actual[name][n],`${name} q${q} slot${n}`).toBeCloseTo(value,5));
    for(const name of ['trigger','clear'])expect(result.outputs[name].every(c=>c.slice(q*128+1,(q+1)*128).every(v=>v===0))).toBe(true);
    return actual;
  });
  return{result,frames,processor};
}
for(const sampleRate of [44100,48000,96000]){
  test(`member isolation, master addition and exact bend centers/endpoints ${sampleRate}`,async()=>{
    const {frames:f}=await trace([
      {bytes:[bend(16383,1),pressure(127,1),cc(74,0,1),bend(0,2),pressure(13,2),cc(74,127,2),on(60,1),on(69,2)]},
      {bytes:[bend(16383,0),pressure(31,0),cc(74,93,0)]},
      {bytes:[bend(8191,1),bend(8193,2)]},{bytes:[bend(8192,0),bend(8192,1),bend(8192,2)]},
      {bytes:[bend(0,0),bend(16383,1)]},
    ],sampleRate);
    expect(f[0].bendSemitones).toEqual([48,-48]);expect(f[1].bendSemitones).toEqual([50,-46]);
    expect(f[2].bendSemitones[0]).toBeCloseTo(2-48/8192,6);expect(f[2].bendSemitones[1]).toBeCloseTo(2+48/8191,6);
    expect(f[3].bendSemitones).toEqual([0,0]);expect(f[4].bendSemitones).toEqual([46,-2]);
  });
  test(`duplicate identities, release tails and reused member channels ${sampleRate}`,async()=>{
    const {frames:f}=await trace([
      {bytes:[on(60,1,30),on(60,1,100),bend(12288,1),pressure(99,1)]},
      {bytes:[off(60,1)]},{bytes:[on(64,1,80)]},{bytes:[cc(74,3,1),off(60,1)]},
      {bytes:[off(64,1),bend(0,1)]},{finish:[0]},{finish:[1]},
      {bytes:[on(72,1)]},
    ],sampleRate);
    expect(f[0].memberPressure[0]).toEqual(f[0].memberPressure[1]);
    expect(f[2].note).toEqual([64,60]);expect(f[3].gate).toEqual([1,0]);
    expect(f[4].bendSemitones).toEqual([-48,-48]);expect(f[7].bendSemitones[0]).toBe(-48);
  });
  test(`steals retain native channel identities and stale note-offs cannot release replacement ${sampleRate}`,async()=>{
    const {frames:f}=await trace([
      {bytes:[on(60,1),on(64,2),bend(0,1),bend(16383,2)]},{bytes:[on(67,2)]},
      {bytes:[off(60,1)]},{bytes:[off(64,2)]},{bytes:[on(69,1)]},
      {bytes:[on(67,2,0)]},{finish:[0,1]},
    ],sampleRate);
    expect(f[1].channel).toEqual([2,2]);expect(f[2].gate).toEqual([1,1]);expect(f[4].channel).toEqual([2,1]);
  });
  test(`member sustain works, master pedals and panic are not propagated ${sampleRate}`,async()=>{
    const {frames:f}=await trace([
      {bytes:[on(60,1),on(64,2),cc(64,127,0)]},{bytes:[off(60,1),cc(64,127,2),off(64,2)]},
      {bytes:[cc(120,0,0),cc(123,0,0),cc(121,0,0)]},{bytes:[cc(64,0,2)]},
      {bytes:[cc(120,0,1)]},{bytes:[cc(120,0,2)]},
    ],sampleRate);
    expect(f[1].gate).toEqual([0,1]);expect(f[2].active).toEqual([1,1]);expect(f[2].gate).toEqual([0,1]);
    expect(f[3].gate).toEqual([0,0]);expect(f[4].active).toEqual([0,1]);expect(f[5].active).toEqual([0,0]);
  });
  test(`CC121 is channel-local, expression reset keeps notes, full composition panic clears ${sampleRate}`,async()=>{
    const {frames:f}=await trace([
      {bytes:[on(60,1),on(64,2),bend(0,0),bend(16383,1),bend(0,2),pressure(127,0),pressure(64,1),cc(74,0,0),cc(74,127,1)]},
      {bytes:[cc(121,0,1)]},{bytes:[cc(121,0,0)]},
      {bytes:[bend(0,1),cc(74,0,2)],reset:'expression'},
      {bytes:[pressure(127,2)],reset:'all'},{bytes:[on(69,2)]},
    ],sampleRate);
    expect(f[1].bendSemitones).toEqual([-2,-50]);expect(f[1].memberTimbre[0]).toBeCloseTo(64/127,7);
    expect(f[2].bendSemitones).toEqual([0,-48]);expect(f[3].gate).toEqual([1,1]);
    expect(f[3].bendSemitones).toEqual([0,0]);expect(f[4].active).toEqual([0,0]);
  });
  test(`outside zone, master notes, poly pressure and RPN are ignored by expression ${sampleRate}`,async()=>{
    const {frames:f}=await trace([
      {bytes:[bend(16383,0),on(60,0),on(64,3),bend(0,3),pressure(127,3),cc(74,127,3)]},
      {bytes:[on(69,1),on(72,2),bend(12288,1),[0xa1,69,127],cc(101,0,1),cc(100,0,1),cc(6,12,1),cc(38,0,1)]},
      {bytes:[cc(101,0,0),cc(100,6,0),cc(6,1,0),bend(0,2)]},
    ],sampleRate);
    expect(f[0].inZone).toEqual([0,0]);expect(f[0].masterBend).toEqual([0,0]);
    expect(f[1].memberPressure).toEqual([0,0]);expect(f[2].inZone).toEqual([1,1]);expect(f[2].bendSemitones[1]).toBe(-46);
  });
  test(`transient snapshot restores empty allocations and expression defaults ${sampleRate}`,async()=>{
    const {result,processor}=await trace([{bytes:[on(60,1),cc(64,127,1),off(60,1),bend(16383,0),bend(0,1),pressure(127,1),cc(74,0,1)]}],sampleRate);
    const restored=await renderOffline(processor,{sampleRate,duration:(128-.25)/sampleRate,restore:result.state});
    expect(restored.outputs.active.every(c=>c.every(x=>x===0))).toBe(true);expect(restored.outputs.memberTimbre.every(c=>c.every(x=>x===0))).toBe(true);
    const fresh=await renderOffline(processor,{sampleRate,duration:(128-.25)/sampleRate,restore:result.state,events:[{name:'midi',payload:wireToMidiEvent(...on(60,1)),atSample:0}]});
    expect(fresh.outputs.bendSemitones[0].every(x=>x===0)).toBe(true);expect(fresh.outputs.memberPressure[0].every(x=>x===0)).toBe(true);
    expect(fresh.outputs.memberTimbre[0][0]).toBeCloseTo(64/127,7);expect(fresh.diagnostics.scrubbedSamples).toBe(0);
  });
  test(`seeded byte-event oracle and maximum configured member count ${sampleRate}`,async()=>{
    let seed=8711;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
    const steps:Step[]=[];
    for(let q=0;q<80;q++){
      const bytes:MidiBytes[]=[];
      for(let n=0;n<3;n++){
        const ch=random()%16,key=60+random()%4,kind=random()%8;
        bytes.push(kind===0?on(key,ch,1+random()%127):kind===1?off(key,ch):kind===2?bend(random()%16384,ch):kind===3?pressure(random()%128,ch):kind===4?cc(74,random()%128,ch):cc([64,120,121,123][random()%4],random()%128,ch));
      }
      steps.push({bytes,reset:q%17===16?'all':q%13===12?'expression':undefined,finish:q%11===10?[0,1,2,3]:[]});
    }
    await trace(steps,sampleRate,{memberChannels:15,memberBendRange:96,masterBendRange:7.5},{mode:'poly',capacity:4,heldCapacity:8});
  });
}

test('both native handler registration orders preserve allocation and expression',async()=>{
  const steps:Step[]=[{bytes:[bend(16383,1),on(60,1),on(64,2),pressure(33,2)]},{bytes:[cc(121,0,1),cc(64,127,2),off(64,2)]},{bytes:[cc(64,0,2)]}];
  const a=await trace(steps),b=await trace(steps,48000,{memberChannels:2},allocation,true);
  expect(a.frames).toEqual(b.frames);
});
test('native quantum FIFO coalesces events rather than claiming sample-accurate expression',async()=>{
  const result=await renderOffline(mpeFixture(),{sampleRate:48000,duration:(384-.25)/48000,events:[
    {name:'midi',payload:wireToMidiEvent(...on(60,1)),atSample:0},
    {name:'midi',payload:wireToMidiEvent(...bend(16383,1)),atSample:129},
    {name:'midi',payload:wireToMidiEvent(...bend(0,1)),atSample:130},
  ]});
  expect(result.outputs.bendSemitones[0][127]).toBe(0);expect(result.outputs.bendSemitones[0][128]).toBe(-48);
});
test('active and channel guards make every expression lane zero without clamping aliases',async()=>{
  const channels=[-2147483648,-1,0,1,2,3,15,16,2147483647];
  const processor=defineProcessor(()=>{
    const expression=instantiate(mpeExpression,{memberChannels:2},{name:'expression'});expression.bindMidi(event.midi({from:'main',name:'midi'}));
    const output=audioOutput({name:'main',channels:channels.length*2});
    return{process(){forSample(i=>{channels.forEach((ch,n)=>{
      for(let active=0;active<2;active++){
        const v=expression.read({active:bool(active>0),channel:i32(ch)});
        output.ch(n*2+active).at(i).write(v.bendSemitones.add(v.memberPressure).add(v.masterPressure).add(v.memberTimbre).add(v.masterTimbre));
      }
    });});}};
  });
  const result=await renderOffline(processor,{sampleRate:48000,duration:(128-.25)/48000,events:[bend(16383,0),bend(16383,1),bend(16383,2),bend(0,3)].map(bytes=>({name:'midi',payload:wireToMidiEvent(...bytes),atSample:0}))});
  result.outputs.main.forEach((c,n)=>expect(c[0]).toBeCloseTo(n===7||n===9?50+128/127:0,5));expect(result.diagnostics.scrubbedSamples).toBe(0);
});
test('zero bend ranges and fractional semitone ranges have explicit bounded behavior',async()=>{
  for(const range of [0,.25,96]){
    const {frames}=await trace([{bytes:[on(60,1),on(64,2),bend(0,1),bend(16383,2),bend(16383,0)]}],48000,{memberChannels:2,memberBendRange:range,masterBendRange:range});
    expect(frames[0].bendSemitones).toEqual([0,range*2]);
  }
});
test('construction rejects invalid zones and bend ranges',()=>{
  for(const memberChannels of [0,-1,16,1.5,NaN,Infinity])expect(()=>mpeFixture({memberChannels})).toThrow();
  for(const field of ['memberBendRange','masterBendRange'] as const)for(const value of [-.1,96.01,NaN,Infinity,-Infinity])expect(()=>mpeFixture({[field]:value})).toThrow();
});
for(const sampleRate of [44100,48000,96000]){
  test(`mono last-note priority changes channel mapping without expression retrigger ${sampleRate}`,async()=>{
    const {frames:f}=await trace([
      {bytes:[bend(0,1),bend(16383,2),on(60,1)]},{bytes:[on(64,2)]},
      {bytes:[off(64,2)]},{bytes:[cc(64,127,1),off(60,1),on(67,2)]},
      {bytes:[off(67,2)]},{bytes:[cc(64,0,1)]},{finish:[0]},
    ],sampleRate,{memberChannels:2},{mode:'mono',capacity:1,heldCapacity:8,legato:true});
    expect(f[0].bendSemitones).toEqual([-48]);expect(f[1].bendSemitones).toEqual([48]);expect(f[1].trigger).toEqual([0]);
    expect(f[2].bendSemitones).toEqual([-48]);expect(f[4].note).toEqual([60]);expect(f[6].inZone).toEqual([0]);
  });
  test(`every member channel has isolated expression storage ${sampleRate}`,async()=>{
    const processor=defineProcessor(()=>{
      const expression=instantiate(mpeExpression,{memberChannels:15},{name:'expression'});expression.bindMidi(event.midi({from:'main',name:'midi'}));
      const pitch=audioOutput({name:'pitch',channels:15}),pressureOut=audioOutput({name:'pressure',channels:15}),timbre=audioOutput({name:'timbre',channels:15});
      return{process(){forSample(i=>{for(let ch=1;ch<=15;ch++){
        const v=expression.read({active:bool(true),channel:i32(ch)});
        pitch.ch(ch-1).at(i).write(v.bendSemitones);pressureOut.ch(ch-1).at(i).write(v.memberPressure);timbre.ch(ch-1).at(i).write(v.memberTimbre);
      }});}};
    });
    const steps=[...[...Array(15)].map((_,n)=>[bend((n+1)*997,n+1),pressure((n+1)*7,n+1),cc(74,(n+1)*8,n+1)]),[bend(16383,0)]];
    const result=await renderOffline(processor,{sampleRate,duration:(steps.length*128-.25)/sampleRate,events:steps.flatMap((s,q)=>s.map(bytes=>({name:'midi',payload:wireToMidiEvent(...bytes),atSample:q*128})))});
    for(let q=0;q<steps.length;q++)for(let ch=1;ch<=15;ch++){
      const changed=ch<=q+1,raw=changed?ch*997:8192;
      expect(result.outputs.pitch[ch-1][q*128]).toBeCloseTo(48*(raw-8192)/(raw<8192?8192:8191)+(q===15?2:0),5);
      expect(result.outputs.pressure[ch-1][q*128]).toBeCloseTo(changed?ch*7/127:0,6);
      expect(result.outputs.timbre[ch-1][q*128]).toBeCloseTo(changed?ch*8/127:64/127,6);
    }
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  });
}
