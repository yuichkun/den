import { PerformanceReference } from './performance-reference.js';
import type { MpeExpressionConfig } from '../../src/mpe-expression.js';
import type { PerformancePolicyConfig } from '../../src/performance.js';
/** Byte fixtures and ordinary object state; no graph logic or native wire decoder. */
export type MidiBytes=readonly [number,number,number];
export class MpeReference {
  channels=Array.from({length:16},()=>({bend:8192,pressure:0,timbre:64}));
  policy:PerformanceReference;
  constructor(readonly config:MpeExpressionConfig,allocation:PerformancePolicyConfig){this.policy=new PerformanceReference(allocation);}
  event([status,a,b]:MidiBytes){
    const channel=status&15,kind=status&240;
    if(kind===0x90)this.policy.on(a,channel,b);
    if(kind===0x80)this.policy.off(a,channel);
    if(kind===0xb0)this.policy.cc(a,channel,b);
    if(channel>(this.config.memberChannels??15))return;
    const c=this.channels[channel];
    if(kind===0xe0)c.bend=a+128*b;
    if(kind===0xd0)c.pressure=a;
    if(kind===0xb0&&a===74)c.timbre=b;
    if(kind===0xb0&&a===121)this.channels[channel]={bend:8192,pressure:0,timbre:64};
  }
  reset(all:boolean){this.channels=this.channels.map(()=>({bend:8192,pressure:0,timbre:64}));if(all)this.policy.reset();}
  frame(){
    const native=this.policy.frame();
    const rows=this.policy.voices.map(v=>{
      const inZone=v.active&&v.channel>=1&&v.channel<=(this.config.memberChannels??15);
      const empty={inZone:0,memberBend:0,masterBend:0,bendSemitones:0,memberPressure:0,masterPressure:0,memberTimbre:0,masterTimbre:0};
      if(!inZone)return empty;
      const c=this.channels[v.channel],m=this.channels[0];
      const bend=(value:number)=>(value-8192)/(value<8192?8192:8191);
      return{inZone:1,memberBend:bend(c.bend),masterBend:bend(m.bend),bendSemitones:bend(c.bend)*(this.config.memberBendRange??48)+bend(m.bend)*(this.config.masterBendRange??2),memberPressure:c.pressure/127,masterPressure:m.pressure/127,memberTimbre:c.timbre/127,masterTimbre:m.timbre/127};
    });
    return Object.fromEntries(['note','channel','velocity','active','gate','trigger','clear',...Object.keys(rows[0])].map(name=>[name,name in rows[0]?rows.map(row=>row[name as keyof typeof row]):native[name]]));
  }
}
