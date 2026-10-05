import { createNode } from '@unworklet/core';
import instrumentProcessor from './instrument.js?worklet';
import delayProcessor from './delay.js?worklet';
import chorusProcessor from './chorus.js?worklet';
import rhythmicProcessor from './rhythmic.js?worklet';
const processors={diagnostic:delayProcessor,chorus:chorusProcessor,rhythmic:rhythmicProcessor};
import {engineConfig,instrumentInitial,delayInitial,masterDefault,masterMaximum,feedbackMaximum,delayCandidates} from './settings.js';
const $=id=>document.getElementById(id), held=new Map(), active=new Set();
let selected="diagnostic";
let session=null,stopping=false,starts=0,closes=0;
const controls=()=>({volume:Number($('volume').value),mix:Number($('mix').value),feedback:Number($('feedback').value)});
function status(message){$('status').textContent=message;}
function buttons(){ $('effect').disabled=!!session||stopping; $('start').disabled=!!session||stopping; for(const id of ['release','reset','stop'])$(id).disabled=!session||stopping; }
function show(){const c=controls();for(const[k,v]of Object.entries(c))$(k+'-value').textContent=v.toFixed(3);$('settings').textContent=JSON.stringify({status:'CANDIDATE — runtime and listening unverified',sampleRate:48000,engineConfig,instrumentInitial,effect:selected,delay:{...delayCandidates[selected],parameters:{...delayCandidates[selected].parameters,mix:c.mix,feedback:c.feedback}},outputGain:c.volume},null,2);}
function apply(){show();const s=session;if(!s?.master)return;const c=controls(),now=s.ctx.currentTime;s.master.gain.setTargetAtTime(Math.max(0,Math.min(masterMaximum,c.volume)),now,.015);s.delay.params.mix.setTargetAtTime(Math.max(0,Math.min(1,c.mix)),now,.015);s.delay.params.feedback.setTargetAtTime(Math.max(0,Math.min(feedbackMaximum,c.feedback)),now,.015);}
$('effect').addEventListener('change',()=>{if(session||stopping){$('effect').value=selected;return;}const value=$('effect').value;if(!processors[value])return;selected=value;const p=delayCandidates[selected].parameters;$('mix').value=p.mix;$('feedback').value=p.feedback;show();status('Effect selected. Start audio to load it.');});
for(const id of ['volume','mix','feedback'])$(id).addEventListener('input',apply);
function send(notes,on){const s=session;if(!s?.ready)return;for(const note of notes)s.instrument.midi.midi.send({type:on?'noteOn':'noteOff',note,velocity:on?100:0,channel:0});}
function release(id){const notes=held.get(id);if(notes&&active.has(id))send(notes,false);held.delete(id);active.delete(id);refreshHeld();}
function refreshHeld(){for(const b of document.querySelectorAll('[data-note],#chord'))b.classList.toggle('held',[...held.keys()].some(k=>k.startsWith(b.id+':')));}
function releaseAll(){for(const id of [...held.keys()])release(id);}
function hold(id,notes){if(stopping||held.has(id))return;held.set(id,notes);refreshHeld();if(session?.ready){send(notes,true);active.add(id);}else void start();}
function draw(s){if(session!==s||!s.ready)return;const data=new Float32Array(s.analyser.fftSize);s.analyser.getFloatTimeDomainData(data);s.peak=data.reduce((p,v)=>Math.max(p,Math.abs(v)),0);const canvas=$('waveform'),pen=canvas.getContext('2d');pen.clearRect(0,0,canvas.width,canvas.height);pen.strokeStyle='#bedb96';pen.beginPath();data.forEach((v,i)=>{const x=i*canvas.width/data.length,y=canvas.height/2-v*(canvas.height/2-2);i?pen.lineTo(x,y):pen.moveTo(x,y);});pen.stroke();$('peak').textContent=`Mono monitor peak ${s.peak.toFixed(5)} · 48 kHz`;s.frame=requestAnimationFrame(()=>draw(s));}
async function start(){
  if(session||stopping)return;
  let ctx;try{ctx=new AudioContext({sampleRate:48000});}catch(e){releaseAll();status(`Audio unavailable: ${e.message}`);return;}
  const s={ctx,ready:false,peak:0,effect:selected};session=s;starts++;buttons();status('Starting candidate…');
  try{
    await ctx.resume();if(ctx.sampleRate!==48000)throw Error('This candidate requires a 48 kHz context.');
    if(session!==s)return;
    const instrument=await createNode(ctx,instrumentProcessor,{initial:instrumentInitial});
    if(session!==s){instrument.dispose();return;}s.instrument=instrument;
    const delay=await createNode(ctx,processors[s.effect],{initial:s.effect==="diagnostic"?delayInitial:{mix:delayCandidates[s.effect].parameters.mix,feedback:delayCandidates[s.effect].parameters.feedback}});
    if(session!==s){delay.dispose();return;}s.delay=delay;
    s.master=new GainNode(ctx,{gain:0});s.analyser=new AnalyserNode(ctx,{fftSize:2048});
    instrument.outputs.main.connect(delay.inputs.main);delay.outputs.main.connect(s.master);s.master.connect(s.analyser).connect(ctx.destination);
    const failed=error=>{if(session===s&&error.code!=='sab-unavailable')void stop().then(()=>status(`Audio failed: ${error.message||error.code||String(error)}`));};
    instrument.onError(failed);delay.onError(failed);
    s.ready=true;apply();for(const[id,notes]of held){send(notes,true);active.add(id);}buttons();draw(s);status('Candidate ready. Hold a note or chord.');
  }catch(e){if(session===s){await stop();status(`Audio unavailable: ${e.message}`);}}
}
async function stop(){
  if(stopping)return;const s=session;if(!s)return;
  stopping=true;releaseAll();session=null;cancelAnimationFrame(s.frame);buttons();
  try{if(s.master&&s.ctx.state!=='closed'){const now=s.ctx.currentTime;s.master.gain.cancelScheduledValues(now);s.master.gain.setValueAtTime(s.master.gain.value,now);s.master.gain.linearRampToValueAtTime(0,now+.02);await new Promise(r=>setTimeout(r,30));}}
  finally{try{s.instrument?.dispose();s.delay?.dispose();}finally{if(s.ctx.state!=='closed')await s.ctx.close();closes++;stopping=false;buttons();status('Audio is off.');$('peak').textContent='Output stopped · context closed';}}
}
function reset(){releaseAll();const s=session;if(!s?.ready)return;s.instrument.events.reset.emit({value:1});s.delay.events.reset.emit({value:1});status('Notes and delay history cleared.');}
$('start').addEventListener('click',()=>void start());$('stop').addEventListener('click',()=>void stop());$('release').addEventListener('click',releaseAll);$('reset').addEventListener('click',reset);
const keys=[...document.querySelectorAll('[data-note]')];keys.forEach((b,i)=>b.id='key-'+i);
for(const b of [...keys,$('chord')]){
  const notes=b.id==='chord'?[60,64,67,72]:[Number(b.dataset.note)];
  b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);hold(b.id+':p'+e.pointerId,notes);});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])b.addEventListener(type,e=>release(b.id+':p'+e.pointerId));
  b.addEventListener('keydown',e=>{if(['Space','Enter'].includes(e.code)){e.preventDefault();if(!e.repeat)hold(b.id+':keyboard',notes);}});
  b.addEventListener('keyup',e=>{if(['Space','Enter'].includes(e.code)){e.preventDefault();release(b.id+':keyboard');}});
  b.addEventListener('blur',()=>release(b.id+':keyboard'));
}
document.addEventListener('keydown',e=>{if(e.target.matches('input,button,select')||e.repeat)return;const b=keys.find(b=>b.dataset.key===e.key.toLowerCase());if(b)hold(b.id+':shortcut',[Number(b.dataset.note)]);});
document.addEventListener('keyup',e=>{const b=keys.find(b=>b.dataset.key===e.key.toLowerCase());if(b)release(b.id+':shortcut');});
window.addEventListener('blur',releaseAll);document.addEventListener('visibilitychange',()=>{if(document.hidden)void stop();});window.addEventListener('pagehide',()=>void stop());
window.denIntegration={state:()=>({selected,activeEffect:session?.effect??null,stopping,ready:!!session?.ready,starting:!!session&&!session.ready,contextState:session?.ctx.state??'closed',held:held.size,starts,closes,peak:session?.peak??0,controls:controls()})};
$('volume').max=String(masterMaximum);$('volume').value=String(masterDefault);show();buttons();
