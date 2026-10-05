import { audioOutput, defineProcessor, event, f32, forSample, instantiate, state } from '@unworklet/core';
import { performancePolicy, type PerformancePolicyConfig } from '../../src/performance.js';
export const performanceFields = ['note','channel','velocity','active','gate','trigger','clear','channelPressure','polyPressure','bend','timbre','sustain'] as const;
const processors = new Map<string, ReturnType<typeof defineProcessor>>();
export function performanceFixture(config: PerformancePolicyConfig) {
  const key = JSON.stringify(config); let result=processors.get(key);
  if (!result) {
    result=defineProcessor(() => {
      const policy=instantiate(performancePolicy,config,{name:'performance'});
      policy.bindMidi(event.midi({from:'main',name:'midi'}));
      const panic=state.bool(false).expose({name:'panic',snapshot:'transient'});
      event<{value:number}>({from:'main',name:'reset'}).onReceive(()=>panic.write(true));
      event<{slot:number}>({from:'main',name:'finish'}).onReceive(e=>policy.voices.forEach((v,n)=>v.releaseFinished(e.slot.eq(n))));
      const outputs=Object.fromEntries(performanceFields.map(name=>[name,audioOutput({name,channels:policy.capacity})]));
      const overflow=audioOutput({name:'overflow',channels:1});
      return {process(){
        policy.reset(panic.read());
        forSample(i=>{
          policy.voices.forEach((voice,n)=>{
            const v={...voice.read(),trigger:voice.takeRetrigger(),clear:voice.takeReset()};
            for(const name of performanceFields)outputs[name].ch(n).at(i).write(f32(v[name]));
          });
          overflow.ch(0).at(i).write(f32(policy.overflowed()));
          panic.write(false);
        });
      }};
    }); processors.set(key,result);
  }
  return result;
}
