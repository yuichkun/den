import {chromium} from 'playwright';
import {preview} from 'vite';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
export async function captureRealtime(output, artifacts) {
const server=await preview({configFile:false,build:{outDir:output},preview:{host:'127.0.0.1',port:0}});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
await page.addInitScript(()=>{
 const AC=AudioContext;window.AudioContext=class extends AC {constructor(...a){super(...a);window.probeContext=this;}};
 const AN=AnalyserNode;window.AnalyserNode=class extends AN {constructor(...a){super(...a);window.probeAnalyser=this;}};
 const raf=requestAnimationFrame;window.requestAnimationFrame=cb=>window.probeNoUi?0:raf(cb);
});
try{
 await page.goto(server.resolvedUrls.local[0]+'audition.html');await page.locator('#start').tap();await page.waitForFunction(()=>window.denAudition.state().peak>0.01);
 const results=[];mkdirSync(artifacts,{recursive:true});
 for(const mode of ['native-sine','full','lfo','controls','no-ui']){
  if(mode==='native-sine')await page.locator('#stop').tap();
  if(mode==='full'){await page.locator('#start').tap();await page.waitForFunction(()=>window.denAudition.state().peak>0.01);}
  if(mode==='no-ui')await page.evaluate(()=>{for(const [id,value] of [['frequency','220'],['depth','0']]){const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));}});
  if(mode==='lfo')await page.locator('#depth').evaluate(el=>{el.value='.5';el.dispatchEvent(new Event('input',{bubbles:true}));});
  const recording=await page.evaluate(async mode=>{
   const ctx=mode==='native-sine'?new AudioContext({sampleRate:48000}):window.probeContext;
   await ctx.resume();
   if(mode==='no-ui')window.probeNoUi=true;
   const code=`class Capture extends AudioWorkletProcessor {constructor(){super();this.data=new Float32Array(240000);this.offset=0;this.sent=false;this.armed=false;this.port.onmessage=()=>{this.armed=true;};} process(inputs){const x=inputs[0]?.[0];if(x&&this.armed&&!this.sent){const n=Math.min(x.length,this.data.length-this.offset);for(let i=0;i<n;i++)this.data[this.offset+i]=x[i];this.offset+=n;if(this.offset===this.data.length){this.sent=true;this.port.postMessage(this.data.buffer,[this.data.buffer]);}}return true;}}registerProcessor('capture-${mode}',Capture);`;
   const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));await ctx.audioWorklet.addModule(url);URL.revokeObjectURL(url);
   const node=new AudioWorkletNode(ctx,'capture-'+mode),mute=new GainNode(ctx,{gain:0});node.connect(mute).connect(ctx.destination);
   let osc,gain;
   if(mode==='native-sine'){osc=new OscillatorNode(ctx,{frequency:220});gain=new GainNode(ctx,{gain:.02275});osc.connect(gain).connect(node);osc.start();}
   else window.probeAnalyser.connect(node);
   const stats=()=>{const s=ctx.playbackStats;return s?JSON.parse(JSON.stringify(s.toJSON?.()??{})):null;};
   const warmUntil=ctx.currentTime+1;while(ctx.currentTime<warmUntil)await new Promise(r=>setTimeout(r,20));
   const before=stats(),wall=performance.now(),audio=ctx.currentTime;
   node.port.postMessage('start');
   let timer;if(mode==='controls'){let high=false;timer=setInterval(()=>{high=!high;const el=document.querySelector('#frequency');el.value=high?'440':'220';el.dispatchEvent(new Event('input',{bubbles:true}));},200);}
   const data=await new Promise(resolve=>{node.port.onmessage=e=>resolve(Array.from(new Float32Array(e.data)));});
   clearInterval(timer);
   const result={data,mode,wallMs:performance.now()-wall,audioSeconds:ctx.currentTime-audio,before,after:stats(),statsProps:ctx.playbackStats?Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.playbackStats)):[]};
   if(osc){osc.stop();osc.disconnect();gain.disconnect();}else window.probeAnalyser.disconnect(node);node.disconnect();mute.disconnect();if(mode==='native-sine')await ctx.close();return result;
  },mode);
  const data=Float32Array.from(recording.data);delete recording.data;
  let maxStep=0,zeros=0,jumps=0;for(let i=1;i<data.length;i++){const delta=Math.abs(data[i]-data[i-1]);maxStep=Math.max(maxStep,delta);if(data[i]===0&&data[i-1]===0)zeros++;if(delta>.002)jumps++;}
  let quantumStep=0;for(let i=128;i<data.length;i+=128)quantumStep=Math.max(quantumStep,Math.abs(data[i]-data[i-1]));
  let sineResidual=null;
  if(['full','no-ui','native-sine'].includes(mode)){
   const w=2*Math.PI*220/48000;let a=0,b=0;
   for(let i=0;i<data.length;i++){a+=data[i]*Math.sin(w*i);b+=data[i]*Math.cos(w*i);}a*=2/data.length;b*=2/data.length;
   sineResidual=0;for(let i=0;i<data.length;i++)sineResidual=Math.max(sineResidual,Math.abs(data[i]-a*Math.sin(w*i)-b*Math.cos(w*i)));
  }
  writeFileSync(join(artifacts,`${mode}.f32`),Buffer.from(data.buffer));
  results.push({...recording,samples:data.length,maxStep,quantumStep,zeros,jumps,sineResidual});
  console.log({mode,wallMs:recording.wallMs,underruns:recording.after?.underrunEvents-recording.before?.underrunEvents,maxStep,sineResidual});
 }
 writeFileSync(join(artifacts,'probe.json'),JSON.stringify(results,null,2));
 return results;
}finally{await browser.close();await new Promise(r=>server.httpServer.close(r));}

}
