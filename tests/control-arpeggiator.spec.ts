import { test, expect } from 'vitest';
import { audioInput, audioOutput, bool, CAPACITY_128, CAPACITY_256, compile, defineProcessor, event, forSample, instantiate, select, state } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { fixedArpeggiator, type ArpeggiatorNote, type ClockMode } from '../src/modulation.js';
const rates=[44100,48000,96000];
const notes:ArpeggiatorNote[]=[{note:60,velocity:90,gate:1},{note:64,velocity:100,gate:0.5},{note:67,velocity:127,gate:0}];
const fixture=(sampleRate:number,mode:ClockMode='free',start=0,pattern=notes)=>defineProcessor(()=>{
  const input=audioInput({channels:4,name:'controls'}),out=audioOutput({channels:2,name:'main'});
  const output=event.midi({to:'main',name:'notes',capacity:CAPACITY_256});
  const frame=state.i32(start).named('frame');
  const arp=instantiate(fixedArpeggiator,{sampleRate,mode,stepsPerBeat:mode==='tempo'?32:1,channel:2,notes:pattern},{name:'arp'});
  return{process(){forSample(i=>{
    const r=arp.tick(output,{rate:input.ch(0).at(i),reset:input.ch(1).at(i).gt(0),seek:input.ch(2).at(i).gt(0),position:input.ch(3).at(i),atSample:frame.read()});
    out.ch(0).at(i).write(r.note);out.ch(1).at(i).write(select(r.gate,1,0));frame.write(frame.read().add(1));
  });}};
});
const render=(p:ReturnType<typeof fixture>,rate:number,rows:number[][],restore?:Uint8Array)=>renderOffline(p,{sampleRate:rate,duration:(rows.length-.25)/rate,
  inputs:{controls:[0,1,2,3].map(ch=>Float32Array.from(rows,r=>r[ch]))},restore});
function reference(rows:number[][],rate:number,mode:ClockMode,start=0,pattern=notes){
  let units=0,pending=true,previousSeek=false,active:number|null=null;
  const events:any[]=[],values:number[][]=[],threshold=rate*(mode==='tempo'?60:1);
  for(let n=0;n<rows.length;n++){
    const row=rows[n].map(Math.fround),reset=row[1]>0,seek=row[2]>0&&!previousSeek&&!reset;
    if(reset)units=0;else if(seek){const p=Math.max(-1048576,Math.min(1048576,row[3]));units=((p%pattern.length+pattern.length)%pattern.length)*threshold;}
    const step=Math.floor(units/threshold),phase=(units-step*threshold)/threshold,tick=!reset&&(seek||pending),note=pattern[step],gate=!reset&&phase<note.gate;
    const emit=(type:string,pitch:number,velocity:number)=>events.push({name:'notes',payload:{type,channel:2,note:pitch,velocity},atSample:(start+n)>>>0});
    if(active!==null&&(!gate||tick)){emit('noteOff',active,0);active=null;}
    if(gate&&(active===null||tick)){emit('noteOn',note.note,note.velocity);active=note.note;}
    values.push([note.note,Number(gate)]);
    const oldStep=step,increment=Math.max(0,Math.min(1000,row[0]))*(mode==='tempo'?32:1);
    if(!reset)units+=increment;
    pending=reset||Math.floor(units/threshold)!==oldStep;
    if(units>=pattern.length*threshold)units-=pattern.length*threshold;
    previousSeek=row[2]>0;
  }
  return{events,values};
}
for(const rate of rates){
  test(`fixed arp note ordering, rests, resets, seeking, tempo and snapshots at ${rate}`,async()=>{
    for(const mode of ['free','tempo'] as const){
      const rows=Array.from({length:2048},(_,n)=>[n<400?1000:n<650?0:n<1000?137+n%101:n<1500?750:1000,
        n>=127&&n<132||n>=513&&n<520||n>=1920?1:0,n>=255&&n<260||n===767||n===1023||n===1535?1:0,
        n<767?0:n<1023?1.75:n<1535?2:1.25]);
      const p=fixture(rate,mode),result=await render(p,rate,rows),expected=reference(rows,rate,mode);
      expect(result.events).toEqual(expected.events);
      result.outputs.main.forEach((channel,ch)=>expect(Array.from(channel)).toEqual(expected.values.map(r=>r[ch])));
      expect(result.diagnostics.scrubbedSamples).toBe(0);
      const active=new Set<number>();
      for(const e of result.events){const p=e.payload as any;if(p.type==='noteOn'){expect(active.size).toBe(0);active.add(p.note);}else expect(active.delete(p.note)).toBe(true);}
      expect(active.size).toBe(0);
      const first=await render(p,rate,rows.slice(0,1024)),last=await render(p,rate,rows.slice(1024),first.state);
      expect([...first.events,...last.events]).toEqual(result.events);
      result.outputs.main.forEach((channel,ch)=>expect(last.outputs.main[ch]).toEqual(channel.slice(1024)));
    }
  },30000);
  test(`native timestamp signed boundary and uint32 wrap are explicit at ${rate}`,async()=>{
    const rows=Array.from({length:256},(_,n)=>[0,n>=250?1:0,n%2===0?1:0,0]);
    for(const start of [2147483584,-64]){
      const p=fixture(rate,'free',start,[{note:127,velocity:127,gate:1}]);
      const result=await render(p,rate,rows);
      expect(result.events).toEqual(reference(rows,rate,'free',start,[{note:127,velocity:127,gate:1}]).events);
      expect(result.events.some(e=>e.atSample===(start+64>>>0))).toBe(true);
      expect(result.events.at(-1)?.payload).toEqual({type:'noteOff',channel:2,note:127,velocity:0});
    }
  },15000);
}

test('native ring uses all 256 slots, drops oldest when undersized, and conditional false emits nothing',async()=>{
  for(const capacity of [CAPACITY_128,CAPACITY_256]){
    const p=defineProcessor(()=>{
      const midi=event.midi({to:'main',name:'notes',capacity}),out=audioOutput({channels:1,name:'main'});
      const remaining=state.i32(128).named('remaining');
      return{process(){forSample(i=>{
        midi.emitIf(remaining.read().gt(0),{type:'noteOff',channel:0,note:60,velocity:0,atSample:i});
        midi.emitIf(remaining.read().gt(0),{type:'noteOn',channel:0,note:60,velocity:100,atSample:i});
        midi.emitIf(false,{type:'noteOn',channel:0,note:127,velocity:127,atSample:i});
        out.ch(0).at(i).write(0);remaining.write(remaining.read().sub(1));
      });}};
    });
    const result=await renderOffline(p,{sampleRate:48000,duration:128/48000});
    expect(result.events.length).toBe(capacity);
    expect(result.events[0].atSample).toBe(capacity===256?0:64);
    result.events.forEach((e,n)=>{
      expect(e.atSample).toBe((capacity===256?0:64)+Math.floor(n/2));
      expect((e.payload as any).type).toBe(n%2?'noteOn':'noteOff');
      expect((e.payload as any).note).toBe(60);
    });
  }
});

test('arp zero rate holds its current note until explicit reset; all-zero gates never emit',async()=>{
  const rows=Array.from({length:512},(_,n)=>[0,n>=127&&n<256||n>=384?1:0,0,0]);
  const r=await render(fixture(48000,'free',0,[{note:60,velocity:100,gate:1}]),48000,rows);
  expect(r.events.map(e=>[e.atSample,(e.payload as any).type])).toEqual([[0,'noteOn'],[127,'noteOff'],[256,'noteOn'],[384,'noteOff']]);
  const rest=await render(fixture(48000,'free',0,[{note:60,velocity:100,gate:0}]),48000,rows);
  expect(rest.events).toEqual([]);
});

test('arp validates its fixed note list and channel',async()=>{
  const invalid=[{channel:-1},{channel:16},{channel:.5},{notes:[]},{notes:Array(65).fill(notes[0])},{notes:[{...notes[0],note:-1}]},{notes:[{...notes[0],note:128}]},
    {notes:[{...notes[0],velocity:0}]},{notes:[{...notes[0],velocity:128}]},{notes:[{...notes[0],gate:-.1}]},{notes:[{...notes[0],gate:NaN}]}];
  for(const extra of invalid){const run=async()=>compile(defineProcessor(()=>{instantiate(fixedArpeggiator,{sampleRate:48000,mode:'free',channel:0,notes,...extra},{name:'arp'});return{process(){}};}));await expect(run()).rejects.toThrow();}
});

test('maximum64-note fixed list traverses/wraps and closes cleanly',async()=>{
  const rate=48000,pattern=Array.from({length:64},(_,n)=>({note:n*2,velocity:n%2?1:127,gate:n%3===0?0:n%3===1?1:0.5}));
  const rows=Array.from({length:4096},(_,n)=>[1000,n>=4000?1:0,0,0]);
  const actual=await render(fixture(rate,'free',0,pattern),rate,rows),expected=reference(rows,rate,'free',0,pattern);
  expect(actual.events).toEqual(expected.events);
  expect(actual.events.at(-1)?.payload).toMatchObject({type:'noteOff'});
  expect(actual.diagnostics.scrubbedSamples).toBe(0);
});
