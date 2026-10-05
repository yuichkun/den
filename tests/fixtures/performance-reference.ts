import type { MidiEvent } from '@unworklet/core';
import type { PerformancePolicyConfig } from '../../src/performance.js';
type Identity={id:number;note:number;channel:number;down:boolean};
type Voice={id:number|null;note:number;channel:number;velocity:number;active:boolean;age:number;release:number;trigger:boolean;clear:boolean;polyPressure:number};
/** Ordinary object/queue oracle, independent of graph buffers and dense ranks. */
export class PerformanceReference {
  keys:Identity[]=[]; voices:Voice[]; pedal=Array(16).fill(false); bend=Array(16).fill(0); pressure=Array(16).fill(0); timbre=Array(16).fill(0);
  nextId=1;clock=0;overflow=false;
  constructor(readonly config:PerformancePolicyConfig) {this.voices=Array.from({length:config.capacity??(config.mode==='mono'?1:4)},()=>this.empty());}
  empty():Voice {return{id:null,note:-1,channel:-1,velocity:0,active:false,age:0,release:0,trigger:false,clear:false,polyPressure:0};}
  free(n:number) {const clear=this.voices[n].clear;this.voices[n]={...this.empty(),clear};}
  activate(n:number,k:Identity,velocity:number,trigger:boolean) {
    const old=this.voices[n],changed=old.note!==k.note||old.channel!==k.channel;
    this.voices[n]={id:k.id,note:k.note,channel:k.channel,velocity,active:true,age:++this.clock,release:0,trigger:old.trigger||trigger,clear:old.clear,polyPressure:trigger||changed||old.id!==k.id?0:old.polyPressure};
  }
  velocities=new Map<number,number>();
  mono() {
    const k=this.keys.at(-1),v=this.voices[0];
    if(k&&v.id!==k.id)this.activate(0,k,this.velocities.get(k.id)!,this.config.legato===false||v.id===null);
    else if(!k&&v.id!==null){v.id=null;v.release=++this.clock;}
  }
  release(k:Identity) {
    this.keys=this.keys.filter(x=>x!==k);
    if(this.config.mode==='mono')this.mono();
    else for(const v of this.voices)if(v.id===k.id){v.id=null;v.release=++this.clock;}
  }
  flush(ch:number) {for(const k of [...this.keys])if(k.channel===ch&&!k.down)this.release(k);}
  off(note:number,ch:number) {const k=this.keys.find(k=>k.note===note&&k.channel===ch&&k.down);if(!k)return;k.down=false;if(!this.pedal[ch])this.release(k);}
  on(note:number,ch:number,velocity:number) {
    if(!velocity){this.off(note,ch);return;}
    if(this.keys.length===(this.config.heldCapacity??8)){this.overflow=true;return;}
    const k={id:this.nextId++,note,channel:ch,down:true};this.keys.push(k);this.velocities.set(k.id,velocity/127);
    if(this.config.mode==='mono')this.mono();
    else {
      let n=this.voices.findIndex(v=>!v.active);
      if(n<0){const released=this.voices.map((v,n)=>({v,n})).filter(x=>x.v.id===null);const pool=released.length?released:this.voices.map((v,n)=>({v,n}));pool.sort((a,b)=>(released.length?a.v.release-b.v.release:a.v.age-b.v.age)||a.n-b.n);n=pool[0].n;}
      this.activate(n,k,velocity/127,true);
    }
  }
  cc(controller:number,ch:number,value:number) {
    if(controller===64){this.pedal[ch]=value>=64;if(!this.pedal[ch])this.flush(ch);}
    if(controller===74)this.timbre[ch]=value/127;
    if(controller===123){for(const k of this.keys)if(k.channel===ch)k.down=false;if(!this.pedal[ch])this.flush(ch);}
    if(controller===121){this.pedal[ch]=false;this.bend[ch]=this.pressure[ch]=this.timbre[ch]=0;for(const v of this.voices)if(v.channel===ch)v.polyPressure=0;this.flush(ch);}
    if(controller===120){
      this.keys=this.keys.filter(k=>k.channel!==ch);this.pedal[ch]=false;
      this.voices.forEach((v,n)=>{if(v.active&&v.channel===ch){this.free(n);this.voices[n].clear=true;}});
      if(this.config.mode==='mono')this.mono();
    }
  }
  event(e:MidiEvent) {
    if(e.type==='noteOn')this.on(e.note,e.channel,e.velocity);
    if(e.type==='noteOff')this.off(e.note,e.channel);
    if(e.type==='cc')this.cc(e.controller,e.channel,e.value);
    if(e.type==='channelPressure')this.pressure[e.channel]=e.pressure/127;
    if(e.type==='pitchBend')this.bend[e.channel]=(e.value-8192)/(e.value<8192?8192:8191);
    if(e.type==='aftertouch')for(const v of this.voices)if(v.active&&v.note===e.note&&v.channel===e.channel)v.polyPressure=e.pressure/127;
  }
  reset(){this.keys=[];this.voices=this.voices.map(()=>({...this.empty(),clear:true}));this.pedal.fill(false);this.bend.fill(0);this.pressure.fill(0);this.timbre.fill(0);this.overflow=false;}
  finish(n:number){if(n<this.voices.length&&this.voices[n].id===null)this.free(n);}
  frame(){
    const fields=this.voices.map(v=>({note:v.note,channel:v.channel,velocity:v.velocity,active:Number(v.active),gate:Number(v.id!==null),trigger:Number(v.trigger),clear:Number(v.clear),
      channelPressure:v.active?this.pressure[v.channel]:0,polyPressure:v.active?v.polyPressure:0,bend:v.active?this.bend[v.channel]:0,timbre:v.active?this.timbre[v.channel]:0,sustain:Number(v.active&&this.pedal[v.channel])}));
    const result:Record<string,number[]>={overflow:[Number(this.overflow)]};
    for(const name of Object.keys(fields[0]))result[name]=fields.map(v=>v[name as keyof typeof v]);
    for(const v of this.voices){v.trigger=false;v.clear=false;}
    return result;
  }
}
