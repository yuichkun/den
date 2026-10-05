import {audioOutput,defineProcessor,f32,forSample,instantiate,param} from '@unworklet/core';
import {oscillator} from '@denaudio/den/oscillator';
import {spectralGate} from '@denaudio/den/spectral-gate';
export default defineProcessor(({sampleRate})=>{
 const source=instantiate(oscillator,{sampleRate,waveform:'sine'},{name:'source'});
 const gate=instantiate(spectralGate,{size:64,hopSize:16},{name:'gate'});
 const threshold=param.f32({default:0,min:0,max:100,automationRate:'a-rate'}).named('threshold');
 const floor=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('floor');
 const reset=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('reset');
 const output=audioOutput({name:'main',channels:2});
 return{process(){forSample((i,everyNSamples)=>{const clear=reset.at(i).gte(.5),x=source.tick(f32(1500),clear).mul(.125);output.ch(0).at(i).write(x);output.ch(1).at(i).write(gate.tick(x,threshold.at(i),floor.at(i),clear,everyNSamples));});}};
});
