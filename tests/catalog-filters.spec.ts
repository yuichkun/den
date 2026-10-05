import { expect, test } from 'vitest';
import { audioInput, audioOutput, defineProcessor, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { stateVariableFilter } from '../src/state-variable-filter.js';
import { biquadEq, type BiquadEqMode } from '../src/biquad-eq.js';
import { crossover } from '../src/crossover.js';
import { formantBank, type FormantBand } from '../src/formant-bank.js';
import { filter } from '../src/filter.js';
import { biquadEq as rejectedDirectEq } from './fixtures/eq-before-tpt.js';

const rates = [44100,48000,96000], responses = ['lowpass','bandpass','highpass','notch','allpass'] as const;
const fill = (n:number,v:number) => new Float32Array(n).fill(v);
const impulse = (n:number) => Float32Array.from({length:n},(_,i)=>i===0?1:0);
const error = (a:ArrayLike<number>,b:ArrayLike<number>) => {expect(a.length).toBe(b.length);let e=0;for(let i=0;i<a.length;i++)e=Math.max(e,Math.abs(a[i]-b[i]));return e;};
const peak = (a:ArrayLike<number>) => {let p=0;for(let i=0;i<a.length;i++){expect(Number.isFinite(a[i])).toBe(true);p=Math.max(p,Math.abs(a[i]));}return p;};
const processors = new Map<string,ReturnType<typeof defineProcessor>>();
function processor(rate:number,mode:'svf'|'cross'|'formant'|BiquadEqMode,bands:readonly FormantBand[]=[]){
 const key=JSON.stringify([rate,mode,bands]);if(processors.has(key))return processors.get(key)!;
 const p=defineProcessor(()=>{
  const input=audioInput({name:'main',channels:5}),out=audioOutput({name:'main',channels:mode==='svf'?6:mode==='cross'?2:1});
  if(mode==='svf'){
   const unit=instantiate(stateVariableFilter,{sampleRate:rate},{name:'unit'}),legacy=instantiate(filter,{sampleRate:rate},{name:'legacy'});
   return {process(){forSample(i=>{const v=unit.tick(input.ch(0).at(i),input.ch(1).at(i),input.ch(2).at(i),input.ch(4).at(i).gt(0));responses.forEach((name,ch)=>out.ch(ch).at(i).write(v[name]));out.ch(5).at(i).write(legacy.tick(input.ch(0).at(i),input.ch(1).at(i),input.ch(2).at(i),input.ch(4).at(i).gt(0)));});}};
  }
  if(mode==='cross'){
   const unit=instantiate(crossover,{sampleRate:rate},{name:'unit'});
   return {process(){forSample(i=>{const v=unit.tick(input.ch(0).at(i),input.ch(1).at(i),input.ch(4).at(i).gt(0));out.ch(0).at(i).write(v.low);out.ch(1).at(i).write(v.high);});}};
  }
  if(mode==='formant'){
   const unit=instantiate(formantBank,{sampleRate:rate,bands},{name:'unit'});
   return {process(){forSample(i=>out.ch(0).at(i).write(unit.tick(input.ch(0).at(i),input.ch(1).at(i),input.ch(2).at(i),input.ch(4).at(i).gt(0))));}};
  }
  const unit=instantiate(biquadEq,{sampleRate:rate,mode},{name:'unit'});
  return {process(){forSample(i=>out.ch(0).at(i).write(unit.tick(input.ch(0).at(i),input.ch(1).at(i),input.ch(2).at(i),input.ch(3).at(i),input.ch(4).at(i).gt(0))));}};
 });processors.set(key,p);return p;
}
async function render(rate:number,mode:Parameters<typeof processor>[1],input:Float32Array,cutoff=1000,q=Math.SQRT1_2,gain=0,options:{controls?:Float32Array[];restore?:Uint8Array;bands?:readonly FormantBand[]}={}){
 const controls=options.controls??[fill(input.length,cutoff),fill(input.length,q),fill(input.length,gain),fill(input.length,0)];
 const result=await renderOffline(processor(rate,mode,options.bands),{sampleRate:rate,duration:(input.length-.5)/rate,inputs:{main:[input,...controls]},...(options.restore?{restore:options.restore}:{})});
 expect(result.diagnostics.scrubbedSamples).toBe(0);expect(result.outputs.main[0].length).toBe(input.length);return result;
}
// Independent RBJ direct-form I recurrence, not the production TPT or DF-II form.
function coefficients(rate:number,frequency:number,q:number,kind:typeof responses[number]|BiquadEqMode,db=0){
 const w=2*Math.PI*Math.min(Math.max(Math.fround(frequency),20),Math.min(20000,.45*rate))/rate;
 const c=Math.cos(w),s=Math.sin(w),alpha=s/(2*Math.min(Math.max(Math.fround(q),.5),10)),A=10**(Math.min(Math.max(Math.fround(db),-24),24)/40);
 let b:number[],a:number[];
 if(kind==='lowpass'){b=[(1-c)/2,1-c,(1-c)/2];a=[1+alpha,-2*c,1-alpha];}
 else if(kind==='highpass'){b=[(1+c)/2,-1-c,(1+c)/2];a=[1+alpha,-2*c,1-alpha];}
 else if(kind==='bandpass'){b=[alpha,0,-alpha];a=[1+alpha,-2*c,1-alpha];}
 else if(kind==='notch'){b=[1,-2*c,1];a=[1+alpha,-2*c,1-alpha];}
 else if(kind==='allpass'){b=[1-alpha,-2*c,1+alpha];a=[1+alpha,-2*c,1-alpha];}
 else if(kind==='peaking'){b=[1+alpha*A,-2*c,1-alpha*A];a=[1+alpha/A,-2*c,1-alpha/A];}
 else{const beta=Math.sqrt(2*A)*s;
  if(kind==='lowShelf'){b=[A*((A+1)-(A-1)*c+beta),2*A*((A-1)-(A+1)*c),A*((A+1)-(A-1)*c-beta)];a=[(A+1)+(A-1)*c+beta,-2*((A-1)+(A+1)*c),(A+1)+(A-1)*c-beta];}
  else{b=[A*((A+1)+(A-1)*c+beta),-2*A*((A-1)+(A+1)*c),A*((A+1)+(A-1)*c-beta)];a=[(A+1)-(A-1)*c+beta,2*((A-1)-(A+1)*c),(A+1)-(A-1)*c-beta];}
 }
 return {b:b.map(x=>x/a[0]),a:a.map(x=>x/a[0])};
}
function direct(input:ArrayLike<number>,c:ReturnType<typeof coefficients>){let x1=0,x2=0,y1=0,y2=0;return Float64Array.from(input,x=>{const y=c.b[0]*x+c.b[1]*x1+c.b[2]*x2-c.a[1]*y1-c.a[2]*y2;x2=x1;x1=x;y2=y1;y1=y;return y;});}
function response(signal:ArrayLike<number>,frequency:number,rate:number){let re=0,im=0;for(let n=0;n<signal.length;n++){const w=2*Math.PI*frequency*n/rate;re+=signal[n]*Math.cos(w);im-=signal[n]*Math.sin(w);}return {re,im,gain:Math.hypot(re,im)};}

for(const rate of rates){
 test(`SVF five independent impulse responses and unchanged legacy lowpass at ${rate}`,async()=>{
  for(const frequency of [20,1000,Math.min(20000,.45*rate)])for(const q of [.5,Math.SQRT1_2,10]){
   const input=impulse(4096),actual=await render(rate,'svf',input,frequency,q);
   for(const [ch,kind]of responses.entries())expect(error(actual.outputs.main[ch],direct(input,coefficients(rate,frequency,q,kind)))).toBeLessThan(2e-6);
   expect(error(actual.outputs.main[0],actual.outputs.main[5])).toBeLessThan(2e-6);
  }
 },120000);
 for(const mode of ['peaking','lowShelf','highShelf'] as const)test(`EQ ${mode} independent impulse/gain/endpoint oracle at ${rate}`,async()=>{
  for(const frequency of [20,1000,Math.min(20000,.45*rate)])for(const gain of [-24,0,24]){
   const input=impulse(4096),actual=await render(rate,mode,input,frequency,2,gain);
   expect(error(actual.outputs.main[0],direct(input,coefficients(rate,frequency,2,mode,gain)))).toBeLessThan(1e-5);
   if(gain===0)expect(error(actual.outputs.main[0],input)).toBeLessThan(2e-6);
  }
  const input=impulse(32768),actual=(await render(rate,mode,input,1000,2,12)).outputs.main[0];
  const center=response(actual,1000,rate).gain;
  expect(center).toBeCloseTo(mode==='peaking'?10**(12/20):10**(12/40),4);
  if(mode==='lowShelf')expect(response(actual,0,rate).gain).toBeCloseTo(10**(12/20),4);
  if(mode==='highShelf')expect(response(actual,rate/2,rate).gain).toBeCloseTo(10**(12/20),4);
 },120000);
 test(`LR4 split has independent cascade match and flat in-phase recombination at ${rate}`,async()=>{
  const input=impulse(32768),frequency=1000,actual=(await render(rate,'cross',input,frequency)).outputs.main;
  for(const [ch,kind]of ['lowpass','highpass'].entries()){
   const c=coefficients(rate,frequency,Math.SQRT1_2,kind as 'lowpass'|'highpass');
   const expected=direct(Float32Array.from(direct(input,c)),c);expect(error(actual[ch],expected)).toBeLessThan(3e-6);
   expect(response(actual[ch],frequency,rate).gain).toBeCloseTo(.5,5);
  }
  const sum=Float64Array.from(actual[0],(x,i)=>x+actual[1][i]);
  for(const hz of [0,20,100,1000,5000,Math.min(18000,.4*rate),rate/2])expect(response(sum,hz,rate).gain).toBeCloseTo(1,5);
  const a=response(actual[0],frequency,rate),b=response(actual[1],frequency,rate);expect(Math.hypot(a.re-b.re,a.im-b.im)).toBeLessThan(2e-6);
  expect(error(sum,input)).toBeGreaterThan(.1); // Magnitude-flat is not zero phase or identity PCM.
 },120000);
 test(`formant bank matches independently summed bandpasses and shifted centers at ${rate}`,async()=>{
  const bands=[{frequencyHz:500,q:4,gain:.5},{frequencyHz:1500,q:8,gain:.25},{frequencyHz:2800,q:3,gain:-.1}];
  const input=impulse(8192);
  for(const ratio of [.5,1,2]){
   const actual=(await render(rate,'formant',input,ratio,1,0,{bands})).outputs.main[0];
   const parts=bands.map(b=>direct(input,coefficients(rate,b.frequencyHz*ratio,b.q,'bandpass')));
   const expected=Float64Array.from(input,(_,i)=>parts.reduce((sum,p,ch)=>sum+p[i]*bands[ch].gain,0));
   expect(error(actual,expected)).toBeLessThan(3e-6);
  }
 },120000);
}
for(const mode of ['svf','cross','peaking','lowShelf','highShelf','formant'] as const)test(`${mode} reset/snapshot/clamps/instance boundaries`,async()=>{
 const rate=48000,n=4096,bands=[{frequencyHz:500,q:4,gain:.5}],input=Float32Array.from({length:n},(_,i)=>i<n/2?.2*Math.sin(i*.07):0);
 const controls=[fill(n,mode==='formant'?1:1000),fill(n,mode==='formant'?1:2),fill(n,12),fill(n,0)];controls[3][n/2]=1;
 const actual=await render(rate,mode,input,0,0,0,{controls,bands});
 for(const channel of actual.outputs.main){expect(peak(channel)).toBeLessThan(16);expect(peak(channel.subarray(n/2))).toBe(0);}
 const half=await render(rate,mode,input.slice(0,n/2),0,0,0,{controls:controls.map(x=>x.slice(0,n/2)),bands});
 const next=await render(rate,mode,input.slice(n/2),0,0,0,{controls:controls.map(x=>x.slice(n/2)),bands,restore:half.state});
 for(let ch=0;ch<next.outputs.main.length;ch++)expect(error(next.outputs.main[ch],actual.outputs.main[ch].subarray(n/2))).toBe(0);
 const continuousInput=Float32Array.from({length:n},(_,i)=>.2*Math.sin(i*.07));
 const continuous=await render(rate,mode,continuousInput,mode==='formant'?1:1000,mode==='formant'?1:2,12,{bands});
 const first=await render(rate,mode,continuousInput.slice(0,n/2),mode==='formant'?1:1000,mode==='formant'?1:2,12,{bands});
 const continued=await render(rate,mode,continuousInput.slice(n/2),mode==='formant'?1:1000,mode==='formant'?1:2,12,{bands,restore:first.state});
 for(let ch=0;ch<continued.outputs.main.length;ch++)expect(error(continued.outputs.main[ch],continuous.outputs.main[ch].subarray(n/2))).toBe(0);
 const bounded=await render(rate,mode,impulse(256),mode==='formant'?.25:20,mode==='formant'?.25:.5,-24,{bands});
 const clamped=await render(rate,mode,impulse(256),-1e6,-1e6,-1e6,{bands});
 for(let ch=0;ch<bounded.outputs.main.length;ch++)expect(error(bounded.outputs.main[ch],clamped.outputs.main[ch])).toBe(0);
},120000);

for(const rate of [NaN,0,7999,192001])test(`rejects invalid rate ${rate}`,()=>{
 expect(()=>processor(rate,'svf')).toThrow();expect(()=>processor(rate,'peaking')).toThrow();expect(()=>processor(rate,'cross')).toThrow();expect(()=>processor(rate,'formant',[{frequencyHz:500,q:1,gain:.5}])).toThrow();
});
test('formant construction rejects unbounded/invalid configuration',()=>{
 for(const bands of [[],Array.from({length:9},()=>({frequencyHz:500,q:1,gain:1})),[{frequencyHz:NaN,q:1,gain:1}],[{frequencyHz:500,q:0,gain:1}],[{frequencyHz:500,q:1,gain:2}]])expect(()=>processor(48000,'formant',bands)).toThrow();
});

for(const mode of ['svf','cross','peaking','lowShelf','highShelf','formant'] as const)test(`${mode} controlled per-sample sweeps stay finite without scrubbing`,async()=>{
 const rate=48000,n=32768,bands=[{frequencyHz:500,q:4,gain:.5},{frequencyHz:2000,q:8,gain:.25}];
 const input=Float32Array.from({length:n},(_,i)=>.05*(Math.sin(i*.13)+Math.sin(i*.037)));
 const frequency=Float32Array.from(input,(_,i)=>mode==='formant'?1+.75*Math.sin(2*Math.PI*i/rate):20*1000**(.5+.5*Math.sin(2*Math.PI*i/rate)));
 const q=Float32Array.from(input,(_,i)=>mode==='formant'?1:.5+9.5*i/(n-1));
 const gain=Float32Array.from(input,(_,i)=>24*Math.sin(2*Math.PI*i/rate));
 const result=await render(rate,mode,input,0,0,0,{bands,controls:[frequency,q,gain,fill(n,0)]});
 for(const channel of result.outputs.main)expect(peak(channel)).toBeLessThan(8);
},120000);

for(const mode of ['svf','peaking','lowShelf','highShelf'] as const)test(`${mode} retains tiny/subnormal signal history rather than state-flushing it`,async()=>{
 const rate=48000,n=4096;
 for(const level of [1e-35,1e-39]){
  const input=fill(n,level),actual=(await render(rate,mode,input,1000,2,12)).outputs.main;
  for(let ch=0;ch<(mode==='svf'?5:1);ch++){
   const kind=mode==='svf'?responses[ch]:mode;
   const expected=Float32Array.from(direct(input,coefficients(rate,1000,2,kind,12)));
   const recovered=Float64Array.from(actual[ch],x=>x/Math.fround(level));
   const reference=Float64Array.from(expected,x=>x/Math.fround(level));
   expect(error(recovered,reference)).toBeLessThan(2e-5);
  }
 }
},120000);

for(const rate of rates)for(const mode of ['peaking','lowShelf','highShelf'] as const)test(`${mode} fast high-Q/gain cutoff sweeps reject direct-form state explosion at ${rate}`,async()=>{
 const n=32768,input=Float32Array.from({length:n},(_,i)=>.1*Math.sin(2*Math.PI*440*i/rate));
 for(const modulationHz of [10,100,1000]){
  const cutoff=Float32Array.from(input,(_,i)=>20*(Math.min(20000,.45*rate)/20)**(.5+.5*Math.sin(2*Math.PI*modulationHz*i/rate)));
  const result=await render(rate,mode,input,0,0,0,{controls:[cutoff,fill(n,10),fill(n,24),fill(n,0)]});
  // Deliberately loose stability ceiling for this adversarial normalized input,
  // not an audio headroom or arbitrary-trajectory guarantee. Rejected DF-II
  // produced 23939.65 here at 44.1k/100Hz and scrubbed at 1kHz modulation.
  expect(peak(result.outputs.main[0])).toBeLessThan(16);
 }
},120000);

test('retained direct-form counterexample fails the same zero-scrub stability oracle',async()=>{
 const rate=48000,n=32768,input=Float32Array.from({length:n},(_,i)=>.1*Math.sin(2*Math.PI*440*i/rate));
 const cutoff=Float32Array.from(input,(_,i)=>20*1000**(.5+.5*Math.sin(2*Math.PI*1000*i/rate)));
 const rejected=defineProcessor(()=>{
  const ins=audioInput({name:'main',channels:2}),out=audioOutput({name:'main',channels:1}),unit=instantiate(rejectedDirectEq,{sampleRate:rate,mode:'peaking'},{name:'rejected'});
  return {process(){forSample(i=>out.ch(0).at(i).write(unit.tick(ins.ch(0).at(i),ins.ch(1).at(i),ins.ch(1).at(i).mul(0).add(10),ins.ch(1).at(i).mul(0).add(24),ins.ch(1).at(i).lt(0))));}};
 });
 const old=await renderOffline(rejected,{sampleRate:rate,duration:(n-.5)/rate,inputs:{main:[input,cutoff]}});
 expect(old.diagnostics.scrubbedSamples).toBeGreaterThan(0);
 const fixed=await render(rate,'peaking',input,0,0,0,{controls:[cutoff,fill(n,10),fill(n,24),fill(n,0)]});
 expect(peak(fixed.outputs.main[0])).toBeLessThan(16);
},120000);
