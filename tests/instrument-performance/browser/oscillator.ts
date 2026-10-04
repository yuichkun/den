import {audioOutput,bool,defineProcessor,f32,forSample,instantiate,state} from '@unworklet/core';
import {oscillator} from '../../../dist/oscillator.js';
export const processor=defineProcessor(({sampleRate})=>{
 const part=instantiate(oscillator,{sampleRate,waveform:'sine'},{name:'part'});
 const value=state.f32(0).expose({name:'value',snapshot:'transient'});
 const output=audioOutput({channels:2,name:'main'});
 return {process(){forSample(i=>{value.write(part.tick(f32(440),bool(false)));output.ch(0).at(i).write(value.read().mul(0.08));output.ch(1).at(i).write(value.read().mul(0.08));});}};
});
