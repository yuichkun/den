import { audioOutput, defineProcessor, event, f32, forSample, instantiate, state } from '@unworklet/core';
import { performancePolicy, type PerformancePolicyConfig } from '../../src/performance.js';
import { mpeExpression, type MpeExpressionConfig } from '../../src/mpe-expression.js';
export const mpeFields = ['note','channel','velocity','active','gate','trigger','clear','inZone','memberBend','masterBend','bendSemitones','memberPressure','masterPressure','memberTimbre','masterTimbre'] as const;
const processors = new Map<string, ReturnType<typeof defineProcessor>>();
export function mpeFixture(config:MpeExpressionConfig={},allocation:PerformancePolicyConfig={mode:'poly',capacity:2,heldCapacity:8},reverseBindings=false) {
  const key=JSON.stringify([config,allocation,reverseBindings]);let processor=processors.get(key);
  if(!processor){
    processor=defineProcessor(()=>{
      const policy=instantiate(performancePolicy,allocation,{name:'policy'});
      const expression=instantiate(mpeExpression,config,{name:'expression'});
      const midi=event.midi({from:'main',name:'midi'});
      if(reverseBindings){expression.bindMidi(midi);policy.bindMidi(midi);}else{policy.bindMidi(midi);expression.bindMidi(midi);}
      const panic=state.bool(false).expose({name:'panic',snapshot:'transient'});
      const resetExpression=state.bool(false).expose({name:'resetExpression',snapshot:'transient'});
      event<{all:number}>({from:'main',name:'reset'}).onReceive(e=>{panic.write(e.all.gt(0));resetExpression.write(true);});
      event<{slot:number}>({from:'main',name:'finish'}).onReceive(e=>policy.voices.forEach((v,n)=>v.releaseFinished(e.slot.eq(n))));
      const outputs=Object.fromEntries(mpeFields.map(name=>[name,audioOutput({name,channels:policy.capacity})]));
      return{process(){
        policy.reset(panic.read());expression.reset(resetExpression.read());
        forSample(i=>{
          policy.voices.forEach((voice,n)=>{
            const v=voice.read(),fields={...v,...expression.read(v),trigger:voice.takeRetrigger(),clear:voice.takeReset()};
            for(const name of mpeFields)outputs[name].ch(n).at(i).write(f32(fields[name]));
          });
        });
        panic.write(false);resetExpression.write(false);
      }};
    });processors.set(key,processor);
  }
  return processor;
}
