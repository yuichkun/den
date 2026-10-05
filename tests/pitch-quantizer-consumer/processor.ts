import { audioInput, audioOutput, defineProcessor, f32, forSample, instantiate } from '@unworklet/core';
import { pitchQuantizer, type PitchQuantizerConfig, type PitchQuantizerOutput } from '@denaudio/den/pitch-quantizer';
export function makeProcessor(configs: PitchQuantizerConfig[]) {
  return defineProcessor(()=>{
    const input=audioInput({channels:2,name:'control'}),output=audioOutput({channels:configs.length*3,name:'main'});
    const units=configs.map((c,n)=>instantiate(pitchQuantizer,c,{name:`quantizer${n}`}));
    return {process(){forSample(i=>{
      units.forEach((unit,n)=>{
        const q: PitchQuantizerOutput=unit.tick(input.ch(0).at(i),input.ch(1).at(i).gt(0));
        [q.pitch,f32(q.degree),f32(q.octave)].forEach((value,ch)=>output.ch(n*3+ch).at(i).write(value));
      });
    });}};
  });
}
