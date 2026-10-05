import { expect, test as baseTest } from 'vitest';
const test = (name: string, fn: () => unknown) => baseTest(name, fn, 30000);
import { audioInput, audioOutput, bool, compile, defineProcessor, f32, forSample, instantiate, select } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { musicalClock, mseg, randomModulator, sampleAndHold, stepSequence, type ClockMode, type MsegConfig } from '../src/modulation.js';
const rates = [44100,48000,96000];
const clamp=(x:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,x));
const channels=(rows:number[][])=>rows[0].map((_,ch)=>Float32Array.from(rows,row=>row[ch]));
const processor=(sampleRate:number,mode:ClockMode='free',steps=3,division=1)=>defineProcessor(()=>{
  const input=audioInput({channels:4,name:'controls'}),output=audioOutput({channels:7,name:'main'});
  const clock=instantiate(musicalClock,{sampleRate,mode,steps,stepsPerBeat:division},{name:'clock'});
  const sequence=instantiate(stepSequence,{sampleRate,mode,stepsPerBeat:division,steps:Array.from({length:steps},(_,n)=>({value:n%2?-0.75:0.5,gate:n%3===0?0:n%3===1?1:0.375}))},{name:'sequence'});
  return{process(){forSample(i=>{
    const c={rate:input.ch(0).at(i),reset:input.ch(1).at(i).gt(0),seek:input.ch(2).at(i).gt(0),position:input.ch(3).at(i)};
    const a=clock.tick(c),b=sequence.tick(c);
    [a.step,a.phase,select(a.tick,1,0),b.value,select(b.gate,1,0),b.step,b.phase].forEach((v,ch)=>output.ch(ch).at(i).write(v));
  });}};
});
const render=(p:ReturnType<typeof processor>,rate:number,rows:number[][],restore?:Uint8Array)=>renderOffline(p,{sampleRate:rate,duration:(rows.length-0.25)/rate,inputs:{controls:channels(rows)},restore});
function checkClock(result:Awaited<ReturnType<typeof render>>,rate:number,rows:number[][],mode:ClockMode,steps:number,division:number) {
  // Independent integral over exact f32 rates. Boundaries are compared in Hz
  // sample units rather than using the implementation's compensated recurrence.
  let position=0,previousSeek=false,pending=true;
  const threshold=rate*(mode==='tempo'?60:1);
  const actual=result.outputs.main;
  rows.forEach((r,n)=>{
    const reset=r[1]>0,seek=r[2]>0&&!previousSeek&&!reset;
    if(reset)position=0;
    else if(seek){const x=clamp(Math.fround(r[3]),-1048576,1048576);position=(x%steps+steps)%steps*threshold;}
    const step=Math.floor(position/threshold),phase=(position-step*threshold)/threshold;
    expect(actual[0][n],`step frame ${n}`).toBe(step);
    expect(Math.abs(actual[1][n]-phase),`phase frame ${n}`).toBeLessThan(7e-8);
    expect(actual[2][n],`tick frame ${n}`).toBe(!reset&&(seek||pending)?1:0);
    expect(actual[3][n]).toBe(step%2?-0.75:0.5);
    const gate=step%3===0?0:step%3===1?1:0.375;
    expect(actual[4][n],`gate frame ${n}`).toBe(!reset&&phase<gate?1:0);
    expect(actual[5][n]).toBe(step);expect(actual[6][n]).toBe(actual[1][n]);
    const oldStep=step;
    if(!reset)position+=clamp(Math.fround(r[0]),0,1000)*(mode==='tempo'?division:1);
    if(position>=steps*threshold)position-=steps*threshold;
    pending=reset||Math.floor(position/threshold)!==oldStep;
    // A one-step cycle still ticks at every wrap.
    if(steps===1&&!reset)pending=phase*threshold+clamp(Math.fround(r[0]),0,1000)*(mode==='tempo'?division:1)>=threshold;
    previousSeek=r[2]>0;
  });
  expect(result.diagnostics.scrubbedSamples).toBe(0);
}
for(const rate of rates){
  test(`clock exact boundaries, sweep, seek edge, held reset and gate at ${rate}`,async()=>{
    for(const mode of ['free','tempo'] as const){
      const steps=3,division=mode==='tempo'?16:1;
      const rows=Array.from({length:4096},(_,n)=>[n<1024?750:n<1280?0:n<2048?-3:n<2560?1e30:100+n%97*0.125,
        n>=127&&n<131||n>=2047&&n<2050?1:0,n>=255&&n<260||n===511||n===1024||n===2303||n===2700?1:0,
        n<511?1.25:n<1024?-0.625:n<2303?3:n<2700?1048600:-1048600]);
      const p=processor(rate,mode,steps,division),result=await render(p,rate,rows);
      checkClock(result,rate,rows,mode,steps,division);
      const first=await render(p,rate,rows.slice(0,2048));
      const resumed=await render(p,rate,rows.slice(2048),first.state);
      result.outputs.main.forEach((v,ch)=>expect(resumed.outputs.main[ch]).toEqual(v.slice(2048)));
    }
  });
  test(`clock no accumulated period rounding over 4 seconds at ${rate}`,async()=>{
    const size=Math.ceil(rate*4/128)*128;
    for(const mode of ['free','tempo'] as const){
      const frequency=mode==='free'?137:137*8/60;
      const rows=Array.from({length:size},()=>[137,0,0,0]);
      const result=await render(processor(rate,mode,7,mode==='free'?1:8),rate,rows);
      let stepMismatches=0,tickMismatches=0;
      for(let n=0;n<size;n++){
        const position=mode==='free'?n*137/rate:n*137*8/(rate*60);
        const step=Math.floor(position)%7;
        if(result.outputs.main[0][n]!==step)stepMismatches++;
        if(result.outputs.main[2][n] !== (n===0||Math.floor(n*frequency/rate)!==Math.floor((n-1)*frequency/rate)?1:0))tickMismatches++;
      }
      expect(stepMismatches).toBe(0);expect(tickMismatches).toBe(0);
      expect(result.diagnostics.scrubbedSamples).toBe(0);
    }
  });
  test(`MSEG curves, zero segments, loop jump and trigger/reset at ${rate}`,async()=>{
    const config:MsegConfig={sampleRate:rate,initial:-0.5,segments:[
      {seconds:0,target:-0.25,curve:'linear'}, {seconds:3/rate,target:1,curve:'easeIn'},
      {seconds:0,target:0.75,curve:'linear'}, {seconds:4/rate,target:-1,curve:'easeOut'},
      {seconds:5/rate,target:0.5,curve:'smoothstep'}, {seconds:2/rate,target:0,curve:'linear'},
      {seconds:0,target:0.25,curve:'linear'},
    ]};
    for(const loop of [false,true]){
      const p=defineProcessor(()=>{
        const input=audioInput({channels:2,name:'controls'}),output=audioOutput({channels:3,name:'main'});
        const unit=instantiate(mseg,{...config,loop},{name:'mseg'});
        return{process(){forSample(i=>{const r=unit.tick({trigger:input.ch(0).at(i).gt(0),reset:input.ch(1).at(i).gt(0)});
          [r.value,select(r.done,1,0),r.segment].forEach((v,ch)=>output.ch(ch).at(i).write(v));});}};
      });
      const rows=Array.from({length:512},(_,n)=>[n<5||n>=127&&n<135||n===200||n>=255&&n<270||n===300?1:0,n>=129&&n<133||n>=257&&n<260?1:0]);
      const result=await render(p,rate,rows);
      let age=-1,previousTrigger=false;
      rows.forEach(([trigger,reset],n)=>{
        if(reset)age=-1;else if(trigger&&!previousTrigger)age=1;else if(age>=0)age=loop?age%14+1:Math.min(14,age+1);
        let expected=-0.5,index=0;
        if(age>=0){
          if(age<=2){expected=-0.25+1.25*(age/3)**2;index=1;}
          else if(age===3){expected=0.75;index=2;}
          else if(age<=7){const t=(age-3)/4;expected=0.75-1.75*(2*t-t*t);index=3;}
          else if(age<=12){const t=(age-7)/5;expected=-1+1.5*(3*t*t-2*t*t*t);index=4;}
          else if(age===13){expected=0.25;index=5;}
          else{expected=0.25;index=6;}
        }
        expect(Math.abs(result.outputs.main[0][n]-expected),`loop ${loop}, frame ${n}`).toBeLessThan(8e-8);
        expect(result.outputs.main[1][n]).toBe(age<0||!loop&&age>=14?1:0);
        expect(result.outputs.main[2][n]).toBe(index);previousTrigger=trigger>0;
      });
      expect(result.diagnostics.scrubbedSamples).toBe(0);
      const first=await render(p,rate,rows.slice(0,256)),resumed=await render(p,rate,rows.slice(256),first.state);
      result.outputs.main.forEach((v,ch)=>expect(resumed.outputs.main[ch]).toEqual(v.slice(256)));
    }
  });
  test(`seeded random, full-range S&H, tiny controls, reset and isolation at ${rate}`,async()=>{
    const p=defineProcessor(()=>{
      const input=audioInput({channels:4,name:'controls'}),output=audioOutput({channels:4,name:'main'});
      const sample=instantiate(sampleAndHold,{initial:2**-149},{name:'sample'});
      const a=instantiate(randomModulator,{initial:0.25,seed:1},{name:'a'});
      const b=instantiate(randomModulator,{initial:0.25,seed:1},{name:'b'});
      const c=instantiate(randomModulator,{initial:-0.5,seed:2147483646},{name:'c'});
      return{process(){forSample(i=>{
        const control={trigger:input.ch(1).at(i).gt(0),reset:input.ch(2).at(i).gt(0),correlation:input.ch(3).at(i)};
        [sample.tick(input.ch(0).at(i),control.trigger,control.reset),a.tick(control),b.tick(control),c.tick(control)].forEach((v,ch)=>output.ch(ch).at(i).write(v));
      });}};
    });
    const values=[2**-149,-(2**-149),1e-35,-1e-35,3.4028234663852886e38,-3.4028234663852886e38,2,-2,0,-0];
    const rows=Array.from({length:1024},(_,n)=>[values[n%values.length],n%7===0||n>=128&&n<192?1:0,n>=255&&n<260||n===511?1:0,n<128?0:n<192?1:n<256?0:n<512?0.95:n<768?-100:100]);
    const result=await render(p,rate,rows);let held=2**-149,seedA=1,seedC=2147483646,a=0.25,c=-0.5;
    rows.forEach((row,n)=>{
      const [v,trig,reset,corr]=row.map(Math.fround),rho=clamp(corr,0,1);
      if(reset){held=2**-149;seedA=1;seedC=2147483646;a=0.25;c=-0.5;}
      else if(trig){held=v===0?0:v;seedA=Number(BigInt(seedA)*16807n%2147483647n);seedC=Number(BigInt(seedC)*16807n%2147483647n);
        a=rho*a+(1-rho)*(2*(seedA-1)/2147483645-1);c=rho*c+(1-rho)*(2*(seedC-1)/2147483645-1);}
      expect(result.outputs.main[0][n]).toBe(held);
      expect(Math.abs(result.outputs.main[1][n]-a)).toBeLessThan(8e-8);
      expect(result.outputs.main[2][n]).toBe(result.outputs.main[1][n]);
      expect(Math.abs(result.outputs.main[3][n]-c)).toBeLessThan(8e-8);
      expect(Math.abs(result.outputs.main[1][n])).toBeLessThanOrEqual(1);
    });
    const first=await render(p,rate,rows.slice(0,640)),resumed=await render(p,rate,rows.slice(640),first.state);
    result.outputs.main.forEach((v,ch)=>expect(resumed.outputs.main[ch]).toEqual(v.slice(640)));
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  });
}

test('construction contracts reject invalid capacities, timing, curves and seeds',async()=>{
  const tryClock=async(config:any)=>compile(defineProcessor(()=>{instantiate(musicalClock,config,{name:'clock'});return{process(){}};}));
  for(const extra of [{sampleRate:7999},{sampleRate:192001},{sampleRate:NaN},{steps:0},{steps:65},{steps:1.5},{mode:'other'},{stepsPerBeat:3},{stepsPerBeat:128},{mode:'free',stepsPerBeat:2}]){
    await expect(tryClock({sampleRate:48000,mode:'tempo',steps:3,...extra})).rejects.toThrow();
  }
  const tryMseg=async(config:any)=>compile(defineProcessor(()=>{instantiate(mseg,config,{name:'mseg'});return{process(){}};}));
  const base={sampleRate:48000,initial:0,segments:[{seconds:1,target:1,curve:'linear'}]};
  for(const extra of [{initial:NaN},{segments:[]},{segments:Array(17).fill(base.segments[0])},{segments:[{seconds:-1,target:0,curve:'linear'}]},
    {segments:[{seconds:31,target:0,curve:'linear'}]},{segments:[{seconds:0,target:2,curve:'linear'}]},
    {segments:[{seconds:0,target:0,curve:'cosine'}]},{loop:true,segments:[{seconds:0,target:0,curve:'linear'}]}])await expect(tryMseg({...base,...extra})).rejects.toThrow();
  const trySeed=async(seed:number)=>compile(defineProcessor(()=>{instantiate(randomModulator,{seed,initial:0},{name:'random'});return{process(){}};}));
  for(const seed of [0,-1,1.5,2147483647,NaN])await expect(trySeed(seed)).rejects.toThrow();
});

test('all-zero MSEG completion, half-sample rounding, tiny clock increments and one-step wraps',async()=>{
  for(const rate of rates){
    const p=defineProcessor(()=>{
      const input=audioInput({channels:4,name:'controls'}),out=audioOutput({channels:6,name:'main'});
      const zero=instantiate(mseg,{sampleRate:rate,initial:0.5,segments:Array.from({length:16},(_,n)=>({seconds:0,target:n/16-0.5,curve:'linear' as const}))},{name:'zero'});
      const short=instantiate(mseg,{sampleRate:rate,initial:0,segments:[{seconds:0.49/rate,target:0.25,curve:'linear'},{seconds:0.5/rate,target:0.75,curve:'linear'},{seconds:0.51/rate,target:1,curve:'linear'}]},{name:'short'});
      const clock=instantiate(musicalClock,{sampleRate:rate,mode:'free',steps:1},{name:'clock'});
      return{process(){forSample(i=>{
        const trigger=input.ch(0).at(i).gt(0),reset=input.ch(1).at(i).gt(0);
        const a=zero.tick({trigger,reset}),b=short.tick({trigger,reset});
        const c=clock.tick({rate:input.ch(2).at(i),reset,seek:bool(false),position:f32(0)});
        [a.value,select(a.done,1,0),b.value,select(b.done,1,0),c.phase,select(c.tick,1,0)].forEach((v,ch)=>out.ch(ch).at(i).write(v));
      });}};
    });
    const rows=Array.from({length:256},(_,n)=>[n<4||n===131?1:0,n>=127&&n<130?1:0,1000,0]);
    const r=await render(p,rate,rows);
    for(let n=0;n<256;n++){
      const active=n<127||n>=131;
      expect(r.outputs.main[0][n]).toBe(active?7/16:0.5);
      expect(r.outputs.main[1][n]).toBe(1);
      expect(r.outputs.main[2][n]).toBe(active?(n===0||n===131?0.75:1):0);
      expect(r.outputs.main[3][n]).toBe(n===0||n===131?0:1);
      const start=n<127?0:130;
      if(n<127||n>=130){const j=n-start;expect(r.outputs.main[5][n]).toBe(j===0||Math.floor(j*1000/rate)!==Math.floor((j-1)*1000/rate)?1:0);}
    }
  }
  const rate=8000,size=65536,rows=Array.from({length:size},()=>[2**-149,0,0,0]);
  const result=await render(processor(rate,'free',1),rate,rows);
  for(const n of [0,3999,4000,8000,16000,32000,65535])expect(result.outputs.main[1][n]).toBe(Math.fround(n*(2**-149)/rate));
  expect(result.outputs.main[1][65535]).toBeGreaterThan(0);
});

test('clock does not round a compensated near-boundary remainder into an early tick',async()=>{
  for(const rate of rates){
    const rows=Array.from({length:256},()=>[0,0,0,0]);
    // Exact f32 summands total rate - 2^-48 after the third nonzero
    // contribution. That is below a binary64 ulp at these sample rates.
    let remaining=rate-1,n=0;
    while(remaining>0){const value=Math.min(1000,remaining);rows[n++][0]=value;remaining-=value;}
    rows[n++][0]=1-2**-24;rows[n++][0]=2**-24-2**-48;
    const before=n;rows[n+3][0]=2**-47;rows[0][2]=1;rows[0][3]=1;
    const r=await render(processor(rate,'free',3),rate,rows);
    for(let k=1;k<=n+3;k++){expect(r.outputs.main[0][k],`rate ${rate}, frame ${k}`).toBe(1);expect(r.outputs.main[2][k]).toBe(0);expect(r.outputs.main[4][k]).toBe(1);}
    expect(r.outputs.main[0][n+4]).toBe(2);expect(r.outputs.main[2][n+4]).toBe(1);
    expect(r.outputs.main[1][before]).toBe(1-2**-24);
  }
});
