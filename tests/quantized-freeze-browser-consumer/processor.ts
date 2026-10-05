import {audioOutput,defineProcessor,f32,forSample,instantiate,param} from '@unworklet/core';
import {pitchQuantizer} from '@denaudio/den/pitch-quantizer';
import {spectralFreeze} from '@denaudio/den/spectral-freeze';
export default defineProcessor(()=>{
 const held=instantiate(pitchQuantizer,{pitchClasses:[7,0,3],hysteresis:.25},{name:'held'});
 const nearest=instantiate(pitchQuantizer,{pitchClasses:[7,0,3],hysteresis:0},{name:'nearest'});
 const spectral=instantiate(spectralFreeze,{size:64,hopSize:16},{name:'spectral'});
 const input=param.f32({default:60,min:-16384,max:16384,automationRate:'a-rate'}).named('pitch');
 const pitchReset=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('pitchReset');
 const level=param.f32({default:.25,min:-1,max:1,automationRate:'a-rate'}).named('level');
 const freeze=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('freeze');
 const reset=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('reset');
 const out=audioOutput({name:'main',channels:12});
 return{process(){forSample((i,everyNSamples)=>{
  const h=held.tick(input.at(i),pitchReset.at(i).gte(.5)),n=nearest.tick(input.at(i),pitchReset.at(i).gte(.5));
  const wet=spectral.tick(level.at(i),freeze.at(i).gte(.5),reset.at(i).gte(.5),everyNSamples);
  [wet,level.at(i),freeze.at(i),reset.at(i),h.pitch,f32(h.degree),f32(h.octave),n.pitch,f32(n.degree),f32(n.octave),input.at(i),pitchReset.at(i)].forEach((value,ch)=>out.ch(ch).at(i).write(value));
 });}};
});
