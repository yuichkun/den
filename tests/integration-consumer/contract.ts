import {chorusSettings,rhythmicDelaySettings,type DelaySettings} from '@denaudio/den/delay-settings';
export const settings:readonly DelaySettings[]=[chorusSettings,rhythmicDelaySettings];
import { createInstrument, bassConfig, bassParameters, percussionConfig, percussionParameters, padConfig, padParameters, diagnosticInstrumentParameters, type InstrumentConfig } from '@denaudio/den/instrument';
import { delayFx, type DelayFxConfig, type DelayFxControls } from '@denaudio/den/delay-fx';
import { defineProcessor, instantiate, audioOutput, forSample, f32, bool } from '@unworklet/core';
const config: InstrumentConfig={mode:'poly',capacity:4};
export const instrument=createInstrument(config);
// The integration uses exactly the public configuration and all native controls.
const sounds:readonly {config:InstrumentConfig;parameters:{[K in keyof typeof diagnosticInstrumentParameters]:number}}[]=[{config:bassConfig,parameters:bassParameters},{config:percussionConfig,parameters:percussionParameters},{config:padConfig,parameters:padParameters}];
export const soundProcessors=sounds.map(sound=>createInstrument(sound.config));
export const delay=defineProcessor(({sampleRate})=>{
  const config:DelayFxConfig={sampleRate,maxDelaySeconds:1};
  const fx=instantiate(delayFx,config,{name:'fx'}),out=audioOutput({channels:2,name:'main'});
  const controls:DelayFxControls={timeLeftSeconds:f32(.125),timeRightSeconds:f32(.1875),sync:bool(false),bpm:f32(120),beatsLeft:f32(1),beatsRight:f32(1),feedback:f32(.5),cutoffHz:f32(1000),mix:f32(1),rateHz:f32(0),depthSeconds:f32(0),bypass:bool(false),reset:bool(false)};
  return {process(){forSample(i=>{const v=fx.tick(f32(0),f32(0),controls);out.ch(0).at(i).write(v.left);out.ch(1).at(i).write(v.right);});}};
});
