import { audioInput, audioOutput, defineProcessor, event, forSample, instantiate, param, state, f32, bool } from '@unworklet/core';
import { delayFx } from '@denaudio/den/delay-fx';
export const delay = defineProcessor(({sampleRate}) => {
  const input=audioInput({name:'main',channels:2}),output=audioOutput({name:'main',channels:2});
  const timeLeft=param.f32({default:.125,min:1/48000,max:1,automationRate:'a-rate'}).named('timeLeft');
  const timeRight=param.f32({default:.1875,min:1/48000,max:1,automationRate:'a-rate'}).named('timeRight');
  const feedback=param.f32({default:.25,min:0,max:.5,automationRate:'a-rate'}).named('feedback');
  const mix=param.f32({default:.35,min:0,max:1,automationRate:'a-rate'}).named('mix');
  const bypass=param.f32({default:0,min:0,max:1,automationRate:'a-rate'}).named('bypass');
  const reset=state.bool(false).expose({name:'resetPending',snapshot:'transient'});
  const panic=event({from:'main',name:'reset'});
  panic.onReceive(()=>reset.write(true));
  const engine=instantiate(delayFx,{sampleRate,maxDelaySeconds:1,tone:'lowpass'},{name:'delay'});
  return {process(){forSample(i=>{
    const value=engine.tick(input.ch(0).at(i),input.ch(1).at(i),{timeLeftSeconds:timeLeft.at(i),timeRightSeconds:timeRight.at(i),feedback:feedback.at(i),mix:mix.at(i),cutoffHz:f32(1000),sync:bool(false),bpm:f32(120),beatsLeft:f32(1),beatsRight:f32(1),rateHz:f32(0),depthSeconds:f32(0),bypass:bypass.at(i).gte(.5),reset:reset.read()});
    output.ch(0).at(i).write(value.left);output.ch(1).at(i).write(value.right);
    reset.write(false);
  });}};
});
