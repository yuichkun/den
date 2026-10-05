import {audioOutput,defineProcessor,f32,forSample,instantiate,param} from '@unworklet/core';
import {oscillator} from '@denaudio/den/oscillator';
import {freezeReverb} from '@denaudio/den/freeze-reverb';
export default defineProcessor(({sampleRate})=>{
 const left=instantiate(oscillator,{sampleRate,waveform:'sine'},{name:'sourceLeft'}),right=instantiate(oscillator,{sampleRate,waveform:'sine'},{name:'sourceRight'});
 const config={sampleRate,roomScale:.5,decaySeconds:.1,transitionSamples:16};
 const a=instantiate(freezeReverb,config,{name:'a'}),b=instantiate(freezeReverb,config,{name:'b'});
 const level=param.f32({default:.15,min:0,max:.2,automationRate:'a-rate'}).named('level');
 const disturb=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('disturb');
 const freeze=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('freeze');
 const reset=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('reset');
 const output=audioOutput({name:'main',channels:8});
 return{process(){forSample(i=>{
  const clear=reset.at(i).gte(.5),controls={freeze:freeze.at(i).gte(.5),reset:clear};
  const x=left.tick(f32(431),clear).mul(level.at(i)),y=right.tick(f32(697),clear).mul(level.at(i)).mul(.5),different=disturb.at(i).mul(.5);
  const av=a.tick(x.add(different),y.sub(different),controls),bv=b.tick(x,y,controls);
  [av.left,av.right,bv.left,bv.right,av.freezeAmount,f32(av.frozen),av.left.sub(bv.left),av.right.sub(bv.right)].forEach((v,ch)=>output.ch(ch).at(i).write(v));
 });}};
});
