import { gateCell } from '@denaudio/den';
import { gate } from '@denaudio/den/gate';
import { instantiate, defineProcessor, audioOutput, forSample, f32 } from '@unworklet/core';
export const composed = defineProcessor(() => {
  const cell = instantiate(gateCell, {scale: 0.5}, {name: 'consumer'});
  const output = audioOutput({channels: 1, name: 'main'});
  return {process() { forSample(i => output.ch(0).at(i).write(cell.tick(f32(1), f32(1)))); }};
});
export { gate };

import { envelope } from '@denaudio/den/envelope';
import { lfo, modulatePitch } from '@denaudio/den/lfo';
import { oscillator } from '@denaudio/den/oscillator';
import { bool } from '@unworklet/core';
export const auditionContract = defineProcessor(() => {
  const env = instantiate(envelope,{sampleRate:48000},{name:'env'});
  const mod = instantiate(lfo,{sampleRate:48000},{name:'mod'});
  const osc = instantiate(oscillator,{sampleRate:48000,waveform:'sine'},{name:'osc'});
  const output = audioOutput({name:'main',channels:1});
  return {process(){forSample(i => {
    const e = env.tick({gate:bool(true),retrigger:bool(false),reset:bool(false),attack:f32(.04),decay:f32(.2),sustain:f32(.65),release:f32(.4)});
    const hz = modulatePitch(f32(220),mod.tick(f32(4),bool(false),f32(0)),f32(.5),21600);
    output.ch(0).at(i).write(osc.tick(hz,bool(false)).mul(e.level));
  });}};
});
