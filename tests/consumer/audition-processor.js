import { audioOutput, bool, defineProcessor, forSample, instantiate, param, state } from '@unworklet/core';
import { envelope } from '@denaudio/den/envelope';
import { lfo, modulatePitch } from '@denaudio/den/lfo';
import { oscillator } from '@denaudio/den/oscillator';

export const audition = defineProcessor(() => {
  const controls = Object.fromEntries(Object.entries({
    gate:[0,0,1], frequency:[220,110,880], attack:[0.04,0.005,2], decay:[0.2,0.005,2],
    sustain:[0.65,0,1], release:[0.4,0.01,3], rate:[4,0,12], depth:[0,0,2],
  }).map(([name,[value,min,max]]) => [name,param.f32({default:value,min,max,automationRate:'a-rate'}).named(name)]));
  const env = instantiate(envelope,{sampleRate:48000},{name:'envelope'});
  const mod = instantiate(lfo,{sampleRate:48000},{name:'lfo'});
  const osc = instantiate(oscillator,{sampleRate:48000,waveform:'sine'},{name:'oscillator'});
  const output = audioOutput({name:'main',channels:1});
  // Materialize composition boundaries: 0.4.1 recursively expands reused
  // expression trees. These same-sample transient values add no delay.
  const modulation=state.f32(0).expose({name:'modulation',snapshot:'transient'});
  const pitch=state.f32(0).expose({name:'pitch',snapshot:'transient'});
  const level=state.f32(0).expose({name:'level',snapshot:'transient'});
  return {process(){forSample(i => {
    const c = Object.fromEntries(Object.entries(controls).map(([name,p]) => [name,p.at(i)]));
    const e = env.tick({gate:c.gate.gt(0.5),retrigger:bool(false),reset:bool(false),attack:c.attack,decay:c.decay,sustain:c.sustain,release:c.release});
    level.write(e.level);
    modulation.write(mod.tick(c.rate,bool(false),c.depth.mul(0)));
    const vibrato=modulation.read();
    pitch.write(modulatePitch(c.frequency,vibrato,c.depth,21600));
    const hz=pitch.read();
    output.ch(0).at(i).write(osc.tick(hz,bool(false)).mul(level.read()));
  });}};
}, {id:'den.audition.envelope-lfo-oscillator.v1'});
