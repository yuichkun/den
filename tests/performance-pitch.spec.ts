import { expect,test } from 'vitest';
import { audioInput,audioOutput,bool,defineProcessor,f32,forSample,instantiate,param } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { pitchGlide,tunedFrequency } from '../src/performance.js';
const clamp=(x:number,a:number,b:number)=>Math.max(a,Math.min(b,x));
const make=()=>defineProcessor(({sampleRate})=>{
  const input=audioInput({name:'controls',channels:4}),out=audioOutput({name:'main',channels:2});
  const glide=instantiate(pitchGlide,{sampleRate},{name:'glide'});
  const transpose=param.f32({default:0,min:-48,max:48,automationRate:'a-rate'}).named('transpose');
  const cents=param.f32({default:0,min:-1200,max:1200,automationRate:'a-rate'}).named('cents');
  const a4=param.f32({default:440,min:220,max:880,automationRate:'a-rate'}).named('a4');
  return {process(){forSample(i=>{
    const note=glide.tick({target:input.ch(0).at(i),seconds:input.ch(1).at(i),reset:input.ch(2).at(i).gt(0),snap:input.ch(3).at(i).gt(0)});
    out.ch(0).at(i).write(note);
    out.ch(1).at(i).write(tunedFrequency({note,transpose:transpose.at(i),cents:cents.at(i),a4:a4.at(i)},sampleRate*.45));
  });}};
});
/** Closed-form line segments; no reciprocal remaining-frame recurrence. */
function reference(controls:Float32Array[],rate:number){
  const output=new Float32Array(controls[0].length);let last=0,start=0,target=0,length=0,position=0,live=false;
  for(let n=0;n<output.length;n++){
    const destination=clamp(controls[0][n],-128,255),snap=controls[2][n]>0||controls[3][n]>0||!live;
    if(snap){target=destination;length=0;position=0;last=destination;}
    else{
      if(destination!==target){target=destination;start=last;length=Math.floor(clamp(controls[1][n],0,30)*rate+.5);position=0;}
      position++;
      last=length===0||position>=length?target:start+(target-start)*position/length;
    }
    output[n]=last;live=true;
  }
  return output;
}
function close(a:Float32Array,b:Float32Array,tolerance=2e-5){expect(a.length).toBe(b.length);let max=0;a.forEach((x,n)=>{expect(Number.isFinite(x)).toBe(true);max=Math.max(max,Math.abs(x-b[n]));});expect(max).toBeLessThan(tolerance);}
for(const sampleRate of [44100,48000,96000]) {
  test(`glide endpoints, interrupted ramp, seconds-only edits, held reset/snap ${sampleRate}`,async()=>{
    const frames=1024;
    const controls=[
      Float32Array.from({length:frames},(_,n)=>n<1?60:n<100?72:n<220?48:n<300?80:n<500?69:n<700?60:n<800?255:1e5),
      Float32Array.from({length:frames},(_,n)=>n<40?128/sampleRate:n<100?1:n<300?96/sampleRate:n<700?300/sampleRate:n<800?-1:0),
      Float32Array.from({length:frames},(_,n)=>n>=290&&n<310?1:0),
      Float32Array.from({length:frames},(_,n)=>n>=490&&n<510?1:0),
    ];
    const processor=make(),result=await renderOffline(processor,{sampleRate,duration:(frames-.25)/sampleRate,inputs:{controls}});
    close(result.outputs.main[0],reference(controls,sampleRate));
    expect(result.outputs.main[0][195]).toBe(48);expect(result.outputs.main[0][700]).toBe(255);expect(result.diagnostics.scrubbedSamples).toBe(0);
    const first=await renderOffline(processor,{sampleRate,duration:(384-.25)/sampleRate,inputs:{controls:controls.map(c=>c.slice(0,384))}});
    const second=await renderOffline(processor,{sampleRate,duration:(640-.25)/sampleRate,inputs:{controls:controls.map(c=>c.slice(384))},restore:first.state});
    expect(second.outputs.main).toEqual(result.outputs.main.map(c=>c.slice(384)));
  });
  test(`tuning independent oracle, extreme finite controls and native AudioParam ramps ${sampleRate}`,async()=>{
    const frames=1024,controls=[Float32Array.from({length:frames},(_,n)=>n%129===0?255:n%131===0?-128:30+n/16),new Float32Array(frames),new Float32Array(frames),new Float32Array(frames)];
    const transpose=Array.from({length:frames},(_,n)=>n<512?-48+96*n/511:48),cents=Array.from({length:frames},(_,n)=>1200*Math.sin(n/13)),a4=Array.from({length:frames},(_,n)=>220+660*n/1023);
    const result=await renderOffline(make(),{sampleRate,duration:(frames-.25)/sampleRate,inputs:{controls},params:{transpose,cents,a4}});
    const expected=Float32Array.from(controls[0],(note,n)=>Math.min(.45*sampleRate,Math.fround(a4[n])*2**((note-69+Math.fround(transpose[n])+Math.fround(cents[n])/100)/12)));
    close(result.outputs.main[1],expected,.008);expect(result.diagnostics.scrubbedSamples).toBe(0);
    expect(()=>close(result.outputs.main[1],Float32Array.from(expected,x=>x*.99),.008)).toThrow();
  });
  test(`tiny signed pitch survives native state and half-sample durations round ${sampleRate}`,async()=>{
    const controls=[Float32Array.from({length:128},(_,n)=>n<2?0:n<4?Math.fround(2**-149):n<6?-Math.fround(2**-149):1),
      Float32Array.from({length:128},(_,n)=>n<6?0:n<8?1.49/sampleRate:1.51/sampleRate),new Float32Array(128),new Float32Array(128)];
    const result=await renderOffline(make(),{sampleRate,duration:(128-.25)/sampleRate,inputs:{controls}});
    expect(result.outputs.main[0]).toEqual(reference(controls,sampleRate));
    expect(result.outputs.main[0][2]).toBe(Math.fround(2**-149));expect(result.outputs.main[0][4]).toBe(-Math.fround(2**-149));
    expect(result.diagnostics.scrubbedSamples).toBe(0);
  });
}
test('construction rejects invalid rate and frequency ceiling',()=>{
  for(const sampleRate of [NaN,0,7999,192001,44100.5])expect(()=>defineProcessor(()=>{instantiate(pitchGlide,{sampleRate},{name:'invalid'});return{process(){}};})).toThrow();
  for(const maximum of [NaN,Infinity,0,-1,1e40])expect(()=>defineProcessor(()=>{const output=audioOutput({name:'main',channels:1});return{process(){forSample(i=>output.ch(0).at(i).write(tunedFrequency({note:f32(69),transpose:f32(0),cents:f32(0),a4:f32(440)},maximum)));}};})).toThrow();
});
