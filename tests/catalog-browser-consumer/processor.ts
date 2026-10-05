import { audioInput, audioOutput, defineProcessor, forSample, instantiate, param, f32 } from '@unworklet/core';
import { drive, reduction } from '@denaudio/den/drive';
import { dynamics } from '@denaudio/den/dynamics';
export default defineProcessor(({sampleRate})=>{
 const input=audioInput({name:'main',channels:1}),out=audioOutput({name:'main',channels:4});
 const gain=param.f32({default:4,min:0,max:16,automationRate:'a-rate'}).named('driveGain');
 const threshold=param.f32({default:-18,min:-120,max:24,automationRate:'a-rate'}).named('threshold');
 const reset=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('reset');
 const shaper=instantiate(drive,{sampleRate,curve:'hard',quality:'adaa'},{name:'shaper'});
 const crusher=instantiate(reduction,{sampleRate},{name:'crusher'});
 const compressor=instantiate(dynamics,{sampleRate,mode:'peak',operation:'compressor'},{name:'compressor'});
 return {process(){forSample(i=>{
  const x=input.ch(0).at(i),clear=reset.at(i).gte(.5),shaped=shaper.tick(x,gain.at(i),f32(1),clear);
  const compressed=compressor.tick(shaped,shaped.neg(),shaped,shaped,{thresholdDb:threshold.at(i),ratio:f32(4),kneeDb:f32(0),rangeDb:f32(120),attack:f32(0),release:f32(0),detectorAttack:f32(0),detectorRelease:f32(0),reset:clear});
  out.ch(0).at(i).write(shaped);out.ch(1).at(i).write(crusher.tick(x,f32(16),f32(1),f32(1),clear));out.ch(2).at(i).write(compressed.left);out.ch(3).at(i).write(compressed.right);
 });}};
});
