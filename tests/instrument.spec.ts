import { test, expect } from 'vitest';
import { defineSubgraph, f32, type Node, type MidiEvent } from '@unworklet/core';
import { renderOffline, type RenderOfflineConfig } from '@unworklet/offline';
import { createInstrument, instrument, type InstrumentConfig } from '../src/instrument.js';
import { replacementInstrument } from '../src/instrument-example.js';
import type { OscillatorConfig } from '../src/oscillator.js';
import type { FilterConfig } from '../src/filter.js';

const dc = defineSubgraph((_config: OscillatorConfig) => ({ tick: (_frequency: Node<'f32'>, _reset: Node<'bool'>) => f32(1) }));
const frequencyProbe = defineSubgraph((_config: OscillatorConfig) => ({ tick: (frequency: Node<'f32'>, _reset: Node<'bool'>) => frequency.div(1000) }));
const wire = defineSubgraph((_config: FilterConfig) => ({ tick: (input: Node<'f32'>, _cutoff: Node<'f32'>, _q: Node<'f32'>, _reset: Node<'bool'>) => input }));
const cutoffProbe = defineSubgraph((_config: FilterConfig) => ({ tick: (_input: Node<'f32'>, cutoff: Node<'f32'>, _q: Node<'f32'>, _reset: Node<'bool'>) => cutoff.div(20000) }));
const on = (note: number, velocity=127, channel=0): MidiEvent => ({type:'noteOn',note,velocity,channel});
const off = (note: number, channel=0): MidiEvent => ({type:'noteOff',note,velocity:0,channel});
const cc = (controller: number, channel=0): MidiEvent => ({type:'cc',controller,value:0,channel});
const setup = {mode:'poly',capacity:2,heldCapacity:8} as const;
const params = {gain:[1],ampAttack:[0],ampDecay:[0],ampSustain:[1],ampRelease:[0],pitchEnvelopeDepth:[0],filterEnvelopeDepth:[0],lfoAmpDepth:[0],lfoPitchDepth:[0],lfoFilterDepth:[0],cutoff:[1000],resonance:[0.5]};
function events(steps: MidiEvent[][]) { return steps.flatMap((es,q)=>es.map(payload=>({name:'midi',payload,atSample:q*128}))); }
async function render(config: InstrumentConfig, steps: MidiEvent[][], sampleRate=48000, options: Partial<RenderOfflineConfig>={}) {
  const result = await renderOffline(createInstrument(config), {sampleRate,duration:(steps.length*128-0.5)/sampleRate,events:events(steps),...options,params:{...params,...options.params}});
  expect(result.outputs.main[0].length).toBe(steps.length*128);
  expect(result.diagnostics.scrubbedSamples).toBe(0);
  expect(result.outputs.main[0]).toEqual(result.outputs.main[1]);
  expect(result.outputs.main[0].every(Number.isFinite)).toBe(true);
  return result;
}
function close(actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance=2e-6) {
  expect(actual.length).toBe(expected.length);
  let error=0; for(let i=0;i<actual.length;i++) error=Math.max(error,Math.abs(actual[i]-expected[i]));
  expect(error).toBeLessThan(tolerance);
}
for(const rate of [44100,48000,96000]) {
  test(`independent MIDI sine → biquad → velocity/amp reference at ${rate}`,async()=>{
    const result=await render(setup,[[on(69,64),on(81)],[],[],[],[off(69),off(81)],[]],rate);
    // Bilinear low-pass transfer coefficients, independent of the SVF states.
    const w=2*Math.PI*1000/rate, alpha=Math.sin(w), a0=1+alpha;
    const b0=(1-Math.cos(w))/2/a0,a1=-2*Math.cos(w)/a0,a2=(1-alpha)/a0;
    const expected=new Float64Array(768);
    for(const [hz,velocity] of [[440,64/127],[880,1]]) {
      let x1=0,x2=0,y1=0,y2=0;
      for(let n=0;n<512;n++) { const x=Math.sin(2*Math.PI*hz*n/rate);const y=b0*(x+2*x1+x2)-a1*y1-a2*y2;
        x2=x1;x1=x;y2=y1;y1=y;expected[n]+=y*velocity; }
    }
    close(result.outputs.main[0],expected);
    expect(()=>close(result.outputs.main[0],Float64Array.from(expected,x=>x*0.9))).toThrow();
  });

  test(`per-voice release and exact silence/free/reuse at ${rate}`,async()=>{
    const result=await render({...setup,oscillator:dc,filter:wire},[[on(60,64),on(64)],[],[off(60)],[],[off(64)],[],[on(67)],[]],rate,{params:{ampRelease:[256/rate]}});
    const expected=Array.from({length:1024},(_,n)=> n<256?1+64/127:n<512?1+(64/127)*(511-n)/256:n<768?(767-n)/256:1);
    close(result.outputs.main[0],expected);
  });

  test(`LFO and pitch/filter/amp envelope depth composition at ${rate}`,async()=>{
    const shared={pitchAttack:[0],pitchDecay:[0],pitchSustain:[0.5],pitchEnvelopeDepth:[12],lfoRate:[20],lfoPitchDepth:[6],lfoAmpDepth:[0.6]};
    const result=await render({...setup,oscillator:frequencyProbe,filter:wire},[[on(69)],[],[],[]],rate,{params:shared});
    const expected=Array.from({length:512},(_,n)=>{const wave=Math.sin(2*Math.PI*20*n/rate);return 0.44*2**((6+6*wave)/12)*(1-0.6*(1-wave)/2);});
    close(result.outputs.main[0],expected);
    const tone=await render({...setup,oscillator:dc,filter:cutoffProbe},[[on(69)],[],[],[]],rate,{params:{filterAttack:[0],filterDecay:[0],filterSustain:[0.5],filterEnvelopeDepth:[2],lfoRate:[20],lfoFilterDepth:[1]}});
    close(tone.outputs.main[0],Array.from({length:512},(_,n)=>1000*2**(1+Math.sin(2*Math.PI*20*n/rate))/20000));
  });
}

test('parameter ramp and bypass preserve phase/release; reset wins over same-block MIDI',async()=>{
  const rate=48000, total=1024;
  const result=await render({...setup,oscillator:dc,filter:wire},[[on(60)],[off(60)],[],[],[on(64)],[],[on(67)],[]],rate,{
    params:{ampRelease:[512/rate],gain:Array.from({length:total},(_,n)=>n/total),bypass:Array.from({length:total},(_,n)=>n>=256&&n<384?1:0)},
    messages:[{name:'reset',payload:{value:1},atQuantum:4}],
  });
  close(result.outputs.main[0],Array.from({length:total},(_,n)=>n<128?n/total:n<256||n>=384&&n<512?(639-n)/512*n/total:n>=768?n/total:0));
});

test('steal/retrigger starts from current amp level; mono legato preserves attack',async()=>{
  const rate=48000;
  for(const legato of [true,false]) {
    const result=await render({mode:'mono',heldCapacity:8,legato,oscillator:dc,filter:wire},[[on(60)],[on(64)],[off(64)],[]],rate,{params:{ampAttack:[512/rate]}});
    const expected=Array.from({length:512},(_,n)=>legato?(n+1)/512:n<128?(n+1)/512:n<256?0.25+0.75*(n-127)/512:0.4375+0.5625*(n-255)/512);
    close(result.outputs.main[0],expected);
  }
  const stolen=await render({...setup,capacity:1,oscillator:dc,filter:wire},[[on(60)],[on(64)],[off(60)],[off(64)]],rate,{params:{ampAttack:[512/rate]}});
  close(stolen.outputs.main[0],Array.from({length:512},(_,n)=>n<128?(n+1)/512:n<384?0.25+0.75*(n-127)/512:0));
});

test('CC120 isolation, CC123 release, same-quantum panic/reallocation and on/off coalescing',async()=>{
  const r=await render({...setup,oscillator:dc,filter:wire},[[on(60,127,0),on(64,64,1)],[cc(120,0),on(67,127,0)],[cc(123,0)],[cc(120,1)],[on(72),off(72)],[]]);
  close(r.outputs.main[0],Array.from({length:768},(_,n)=>n<128?1+64/127:n===128?64/127:n<256?1+64/127:n<384?64/127:0));
});

test('CC120 replacement begins at phase zero after the clearing sample',async()=>{
  for(const rate of [44100,48000,96000]) {
    const result=await render({...setup,capacity:1,filter:wire},[[on(69)],[cc(120),on(81)],[],[off(81)]],rate);
    const expected=Array.from({length:512},(_,n)=>n<128?Math.sin(2*Math.PI*440*n/rate):
      n===128||n>=384?0:Math.sin(2*Math.PI*880*(n-129)/rate));
    close(result.outputs.main[0],expected);
  }
});

test('replacement oscillator/filter example has independently defined response',async()=>{
  const rate=48000,n=512;
  const result=await renderOffline(replacementInstrument,{sampleRate:rate,duration:n/rate,events:events([[on(69)]]),params});
  const expected=new Float64Array(n);const w=2*Math.PI*1000/rate,a=w/(1+w);let y=0;
  for(let i=0;i<n;i++){y+=a*(0.5*Math.sin(2*Math.PI*440*i/rate)-y);expected[i]=y;}
  close(result.outputs.main[0],expected,5e-6);
});

test('default combined capacity renders and snapshots do not revive held notes',async()=>{
  const first=await renderOffline(instrument,{sampleRate:48000,duration:128/48000,events:events([[on(69)]]),params});
  expect(first.diagnostics.scrubbedSamples).toBe(0);
  const restored=await renderOffline(instrument,{sampleRate:48000,duration:128/48000,restore:first.state});
  expect(restored.outputs.main[0].every(x=>x===0)).toBe(true);
},60000);

test('combined construction bound: 16 voices / 256 held identities; fail before compiling 32',async()=>{
  expect(()=>createInstrument({...setup,capacity:32})).toThrow(/compiled graph limit/);
  const result=await render({...setup,capacity:16,heldCapacity:256},[Array.from({length:16},(_,n)=>on(48+n)),[cc(120)]],48000);
  expect(result.outputs.main[0].slice(128).every(x=>x===0)).toBe(true);
},60000);

test('staggered voices keep independent pitch/filter envelopes under one free-running LFO',async()=>{
  const rate=48000;
  const steps=[[on(69)],[on(69)],[off(69)],[]];
  for(const target of ['pitch','filter']) {
    const config={...setup,oscillator:target==='pitch'?frequencyProbe:dc,filter:target==='pitch'?wire:cutoffProbe};
    const edits=target==='pitch'?{pitchAttack:[0],pitchDecay:[512/rate],pitchSustain:[0],pitchEnvelopeDepth:[12],lfoPitchDepth:[12]}:
      {filterAttack:[0],filterDecay:[512/rate],filterSustain:[0],filterEnvelopeDepth:[1],lfoFilterDepth:[1]};
    const result=await render(config,steps,rate,{params:{...edits,lfoRate:[20]}});
    close(result.outputs.main[0],Array.from({length:512},(_,n)=>{
      const wave=Math.sin(2*Math.PI*20*n/rate);
      const amount=(start:number)=>(target==='pitch'?0.44:0.05)*2**((511-(n-start))/512+wave);
      return (n<256?amount(0):0)+(n>=128?amount(128):0);
    }));
  }
});

test('musical depths combine before frequency clamping, including opposite-sign cancellation',async()=>{
  const rate=48000;
  const result=await render({...setup,oscillator:frequencyProbe,filter:wire},Array.from({length:32},(_,n)=>n===0?[on(127)]:[]),rate,{
    params:{pitchAttack:[0],pitchDecay:[0],pitchSustain:[1],pitchEnvelopeDepth:[24],lfoRate:[20],lfoPitchDepth:[24]},
  });
  const base=Math.fround(440*2**((127-69)/12));
  close(result.outputs.main[0],Array.from({length:4096},(_,n)=>{
    const semitones=Math.max(-24,Math.min(24,24+24*Math.sin(2*Math.PI*20*n/rate)));
    return Math.min(0.45*rate,base*2**(semitones/12))/1000;
  }),1e-5);
});
