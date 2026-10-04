import { createNode } from '@unworklet/core';
import processor from './audition-processor.js?worklet';
import source from './audition-processor.js?raw';
import './audition.css';

const $ = id => document.getElementById(id);
$('source').textContent = source;
const controls = [...document.querySelectorAll('[data-param]')];
let session = null, epoch = 0, stopping = false, starts = 0, closes = 0;
const settings = () => Object.fromEntries(controls.map(el => [el.dataset.param,Number(el.value)]));
function showSettings() {
  for (const el of controls) $(el.id+'-value').textContent = el.value + (el.dataset.unit || '');
  $('settings').textContent = JSON.stringify({sampleRate:48000,waveform:'sine',...settings(),status:'CANDIDATE — not listening-approved'},null,2);
}
function status(text) { $('status').textContent = text; }
function buttons() {
  $('start').disabled = Boolean(session) || stopping;
  $('stop').disabled = !session || stopping;
  $('release').disabled = !session?.node || stopping;
}
function apply() {
  showSettings();
  const s = session;
  if (!s?.node) return;
  for (const [name,value] of Object.entries(settings())) {
    if (name === 'volume') s.master.gain.setTargetAtTime(value,s.ctx.currentTime,0.015);
    else s.node.params[name].setTargetAtTime(value,s.ctx.currentTime,0.015);
  }
}
controls.forEach(el => el.addEventListener('input',apply));
const canvas = $('waveform'), pen = canvas.getContext('2d');
function draw(s) {
  if (session !== s || !s.node) return;
  s.analyser.getFloatTimeDomainData(s.samples);
  s.peak = Math.max(...s.samples.map(Math.abs));
  pen.clearRect(0,0,canvas.width,canvas.height);
  pen.strokeStyle='#304b47'; pen.beginPath();pen.moveTo(0,canvas.height/2);pen.lineTo(canvas.width,canvas.height/2);pen.stroke();
  pen.strokeStyle='#bcf575'; pen.lineWidth=2;pen.beginPath();
  s.samples.forEach((v,i)=>{const x=i/(s.samples.length-1)*canvas.width,y=canvas.height/2-v*canvas.height*4; if(i===0)pen.moveTo(x,y);else pen.lineTo(x,y);});pen.stroke();
  $('peak').textContent = `Output peak ${s.peak.toFixed(4)} · 48 kHz`;
  s.frame = requestAnimationFrame(()=>draw(s));
}
async function start(held = true) {
  if (session || stopping) { if (session?.node && held) strike(); return; }
  const id = ++epoch;
  const ctx = new AudioContext({sampleRate:48000});
  const s = {ctx,id,node:null,held,peak:0,frame:0}; session=s; starts++;buttons();status('Starting…');
  try {
    // Resume in the user gesture, before asynchronous worklet installation.
    await ctx.resume();
    if (ctx.sampleRate !== 48000) throw new Error('This candidate needs a 48 kHz audio context.');
    const values=settings(); delete values.volume;
    const node=await createNode(ctx,processor,{initial:{...values,gate:0}});
    if (session !== s || id !== epoch) { node.dispose(); return; }
    s.node=node;
    s.master=new GainNode(ctx,{gain:0});
    s.analyser=new AnalyserNode(ctx,{fftSize:2048});s.samples=new Float32Array(2048);
    node.outputs.main.connect(s.master);
    s.master.connect(s.analyser).connect(ctx.destination);
    apply();
    if (s.held) strike();
    buttons();draw(s);status(s.held?'Playing candidate sine tone.':'Ready. Hold the pad to play.');
  } catch(error) {
    if(session===s){await stop(); status(`Audio unavailable: ${error.message}`);}
  }
}
function strike() {
  const s=session;if(!s?.node || stopping)return;
  const now=s.ctx.currentTime;
  s.node.params.gate.cancelScheduledValues(now);
  s.node.params.gate.setValueAtTime(0,now);
  s.node.params.gate.setValueAtTime(1,now+0.005);
  s.held=true;status('Playing candidate sine tone.');
}
function release() {
  const s=session;if(!s)return;s.held=false;
  if(s.node){s.node.params.gate.cancelScheduledValues(s.ctx.currentTime);s.node.params.gate.setValueAtTime(0,s.ctx.currentTime);}
  status('Released — listen to the tail. Stop closes audio.');
}
async function stop() {
  if(stopping)return;
  const s=session;if(!s)return;
  stopping=true;epoch++;buttons();cancelAnimationFrame(s.frame);
  try {
    if(s.master && s.ctx.state!=='closed') {
      s.master.gain.cancelScheduledValues(s.ctx.currentTime);
      s.master.gain.setValueAtTime(s.master.gain.value,s.ctx.currentTime);
      s.master.gain.linearRampToValueAtTime(0,s.ctx.currentTime+0.02);
      await new Promise(r=>setTimeout(r,30));
    }
    s.node?.dispose();
    if(s.ctx.state!=='closed')await s.ctx.close();
  } finally {
    closes++; if(session===s)session=null;stopping=false;
    pen.clearRect(0,0,canvas.width,canvas.height);$('peak').textContent='Output stopped · audio context closed';
    status('Stopped.');buttons();
  }
}
$('start').addEventListener('click',()=>start());
$('release').addEventListener('click',release);
$('stop').addEventListener('click',()=>stop());
const pad=$('pad');let pointer=null;
pad.addEventListener('pointerdown',e=>{if(pointer!==null)return;e.preventDefault();pointer=e.pointerId;pad.setPointerCapture(pointer);pad.classList.add('pressed');start();});
function lift(e){if(e.pointerId!==pointer)return;pointer=null;pad.classList.remove('pressed');release();}
for(const type of ['pointerup','pointercancel','lostpointercapture'])pad.addEventListener(type,lift);
pad.addEventListener('keydown',e=>{if((e.code==='Space'||e.code==='Enter')&&!e.repeat){e.preventDefault();start();}});
pad.addEventListener('keyup',e=>{if(e.code==='Space'||e.code==='Enter'){e.preventDefault();release();}});
pad.addEventListener('blur',release);
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
window.addEventListener('pagehide',()=>stop());
window.addEventListener('blur',release);
window.denAudition={state:()=>({running:!!session?.node,starting:!!session&&!session.node,stopping,contextState:session?.ctx.state??'closed',peak:session?.peak??0,starts,closes,sampleRate:session?.ctx.sampleRate??48000,settings:settings()})};
showSettings();buttons();
