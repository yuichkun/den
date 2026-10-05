import { audioOutput, defineProcessor, event, f32, forSample, instantiate, param, select, state } from '@unworklet/core';
import { performancePolicy, tunedFrequency, type PerformancePolicyConfig } from '@denaudio/den/performance';
import { mpeExpression, type MpeExpressionConfig, type MpeExpressionVoice } from '@denaudio/den/mpe-expression';
import { envelope } from '@denaudio/den/envelope';
import { oscillator } from '@denaudio/den/oscillator';
/** Small diagnostic composition, not a new instrument or preset. */
export function makeProcessor(config: PerformancePolicyConfig={mode:'poly',capacity:4,heldCapacity:8},expressionConfig: MpeExpressionConfig={memberChannels:15}) {
  return defineProcessor(({sampleRate})=>{
    const policy=instantiate(performancePolicy,config,{name:'performance'});
    const expression=instantiate(mpeExpression,expressionConfig,{name:'expression'});
    const midi=event.midi({from:'main',name:'midi'});
    policy.bindMidi(midi);expression.bindMidi(midi);
    const panic=state.bool(false).expose({name:'panic',snapshot:'transient'});
    event<{value:number}>({from:'main',name:'reset'}).onReceive(()=>panic.write(true));
    const rendered=state.bool(false).named('rendered'),live=state.bool(false).expose({name:'live',snapshot:'transient'});
    const output=audioOutput({name:'main',channels:1}),frequency=audioOutput({name:'frequency',channels:policy.capacity}),levels=audioOutput({name:'level',channels:policy.capacity});
    const transpose=param.f32({default:0,min:-48,max:48,automationRate:'a-rate'}).named('transpose');
    const cents=param.f32({default:0,min:-1200,max:1200,automationRate:'a-rate'}).named('cents');
    const a4=param.f32({default:440,min:220,max:880,automationRate:'a-rate'}).named('a4');
    const release=param.f32({default:.01,min:0,max:30,automationRate:'a-rate'}).named('release');
    const gain=param.f32({default:.2,min:0,max:1,automationRate:'a-rate'}).named('gain');
    const completed=state.buffer.bool({size:policy.capacity}).expose({name:'completed',snapshot:'transient'});
    const deferred=state.buffer.bool({size:policy.capacity}).expose({name:'deferred',snapshot:'transient'});
    const pitch=state.buffer.f32({size:policy.capacity}).expose({name:'pitch',snapshot:'transient'});
    const frequencyState=state.buffer.f32({size:policy.capacity}).expose({name:'frequencyState',snapshot:'transient'});
    const parts=policy.voices.map((_,n)=>({amp:instantiate(envelope,{sampleRate},{name:`amp${n}`}),source:instantiate(oscillator,{sampleRate,waveform:'sine'},{name:`source${n}`})}));
    return{process(){
      policy.reset(panic.read());expression.reset(panic.read());
      forSample(i=>{
        let sum=f32(0);
        policy.voices.forEach((voice,n)=>{
          const v=voice.read(),clear=voice.takeReset().or(v.active.not()).or(rendered.read().and(live.read().not()));
          const trigger=voice.takeRetrigger().or(deferred.read(n));
          deferred.write(n,clear.and(v.active).and(v.gate).and(trigger));
          const mapped: MpeExpressionVoice=v;
          const e=expression.read(mapped);
          const p=parts[n],env=p.amp.tick({gate:v.gate.and(clear.not()),retrigger:trigger,reset:clear,attack:f32(0),decay:f32(0),sustain:f32(1),release:release.at(i)});
          // Materialize pitch before the bounded conversion/oscillator graph.
          pitch.write(n,f32(v.note).add(e.bendSemitones));
          frequencyState.write(n,tunedFrequency({note:pitch.read(n),transpose:transpose.at(i),cents:cents.at(i),a4:a4.at(i)},.45*sampleRate));
          const hz=frequencyState.read(n);
          const wave=p.source.tick(hz,clear.or(trigger));
          const expressionGain=f32(.5).add(e.memberPressure.mul(.25)).add(e.masterPressure.mul(.25)).mul(f32(.5).add(e.memberTimbre.mul(.25)).add(e.masterTimbre.mul(.25)));
          const level=select(clear.or(e.inZone.not()),f32(0),env.level.mul(v.velocity).mul(expressionGain));
          sum=sum.add(wave.mul(level));
          frequency.ch(n).at(i).write(select(v.active,hz,f32(0)));levels.ch(n).at(i).write(level);
          completed.write(n,env.done);
        });
        output.ch(0).at(i).write(select(panic.read(),f32(0),sum.mul(gain.at(i))));
        panic.write(false);rendered.write(true);live.write(true);
      });
      policy.voices.forEach((voice,n)=>voice.releaseFinished(completed.read(n)));
    }};
  });
}
