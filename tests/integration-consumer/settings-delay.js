import { audioInput, audioOutput, defineProcessor, event, forSample, instantiate, param, state, f32, bool } from '@unworklet/core';
import { delayFx } from '@denaudio/den/delay-fx';
// Existing settings are compile-time configuration plus existing AudioParams.
export function createSettingsDelay(setting) {
 return defineProcessor(({sampleRate})=>{
  const input=audioInput({name:'main',channels:2}),output=audioOutput({name:'main',channels:2});
  const p=setting.parameters;
  const feedback=param.f32({default:p.feedback,min:0,max:.5,automationRate:'a-rate'}).named('feedback');
  const mix=param.f32({default:p.mix,min:0,max:1,automationRate:'a-rate'}).named('mix');
  const reset=state.bool(false).expose({name:'resetPending',snapshot:'transient'});
  event({from:'main',name:'reset'}).onReceive(()=>reset.write(true));
  const engine=instantiate(delayFx,{sampleRate,...setting.config},{name:'delay'});
  return {process(){forSample(i=>{
   const controls=Object.fromEntries(Object.entries(p).map(([key,value])=>[key,typeof value==='boolean'?bool(value):f32(value)]));
   const value=engine.tick(input.ch(0).at(i),input.ch(1).at(i),{...controls,feedback:feedback.at(i),mix:mix.at(i),reset:reset.read()});
   output.ch(0).at(i).write(value.left);output.ch(1).at(i).write(value.right);reset.write(false);
  });}};
 });
}
