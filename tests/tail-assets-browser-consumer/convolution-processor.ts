import {audioOutput,CAPACITY_16,defineProcessor,event,f32,forSample,instantiate,param} from '@unworklet/core';
import {oscillator} from '@denaudio/den/oscillator';
import {preparedConvolution,type PreparedConvolutionPacket} from '@denaudio/den/prepared-convolution';
export default defineProcessor(({sampleRate})=>{
 const source=instantiate(oscillator,{sampleRate,waveform:'sine'},{name:'source'});
 const convolution=instantiate(preparedConvolution,{blockSize:128,partitions:64},{name:'convolution'});
 event<PreparedConvolutionPacket>({from:'main',name:'ir',capacity:CAPACITY_16,payloadCapacity:131072}).onReceive(packet=>convolution.load(packet));
 const reset=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('reset');
 const output=audioOutput({name:'main',channels:4});
 return{process(){forSample((i,everyNSamples)=>{const clear=reset.at(i).gte(.5),x=source.tick(f32(562.5),clear).mul(.125);const r=convolution.tick(x,clear,everyNSamples);[x,r.output,f32(r.loaded),f32(r.rejected)].forEach((v,ch)=>output.ch(ch).at(i).write(v));});}};
});
