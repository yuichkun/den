import { defineProcessor, audioInput, audioOutput, param, instantiate, forSample, f32 } from '@unworklet/core';
import { stateVariableFilter } from '@denaudio/den/state-variable-filter';
import { biquadEq } from '@denaudio/den/biquad-eq';
import { crossover } from '@denaudio/den/crossover';
import { formantBank } from '@denaudio/den/formant-bank';
export default defineProcessor(({sampleRate})=>{
 const input=audioInput({name:'main',channels:1}),output=audioOutput({name:'main',channels:5});
 const cutoff=param.f32({default:1000,min:20,max:20000,automationRate:'a-rate'}).named('cutoff'),gain=param.f32({default:0,min:-24,max:24,automationRate:'a-rate'}).named('gain'),reset=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('reset');
 const svf=instantiate(stateVariableFilter,{sampleRate},{name:'svf'}),eq=instantiate(biquadEq,{sampleRate,mode:'peaking'},{name:'eq'}),cross=instantiate(crossover,{sampleRate},{name:'cross'});
 const formants=instantiate(formantBank,{sampleRate,bands:[{frequencyHz:500,q:4,gain:.5},{frequencyHz:1500,q:8,gain:.25}]},{name:'formants'});
 return {process(){forSample(i=>{
  const x=input.ch(0).at(i),hz=cutoff.at(i),clear=reset.at(i).gte(.5);
  const filtered=svf.tick(x,hz,f32(Math.SQRT1_2),clear),split=cross.tick(x,hz,clear);
  output.ch(0).at(i).write(filtered.lowpass);output.ch(1).at(i).write(eq.tick(x,hz,f32(2),gain.at(i),clear));
  output.ch(2).at(i).write(split.low);output.ch(3).at(i).write(split.high);output.ch(4).at(i).write(formants.tick(x,f32(1),f32(1),clear));
 });}};
});
