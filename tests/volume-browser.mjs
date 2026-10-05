import assert from 'node:assert/strict';
// Observe actual stereo master output without replacing the product's route.
export async function installVolumeMeter(page){
 await page.evaluate(async()=>{
  const ctx=window.__contexts.at(-1);
  const code=`class Meter extends AudioWorkletProcessor{constructor(){super();this.clear();this.port.onmessage=()=>{this.port.postMessage({frames:this.n,peak:this.peak,rms:this.sum.map(v=>Math.sqrt(v/Math.max(1,this.n))),maxStep:this.step,nonfinite:this.bad,clipped:this.clip});this.clear();};}clear(){this.n=0;this.peak=[0,0];this.sum=[0,0];this.step=[0,0];this.last=this.last||[0,0];this.bad=0;this.clip=0;}process(inputs){const a=inputs[0];for(let i=0;i<128;i++){for(let c=0;c<2;c++){const x=a[c]?.[i]??0;if(!Number.isFinite(x))this.bad++;if(Math.abs(x)>=1)this.clip++;this.peak[c]=Math.max(this.peak[c],Math.abs(x));this.sum[c]+=x*x;this.step[c]=Math.max(this.step[c],Math.abs(x-this.last[c]));this.last[c]=x;}this.n++;}return true;}}registerProcessor('volume-meter',Meter);`;
  const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));await ctx.audioWorklet.addModule(url);URL.revokeObjectURL(url);
  const m=new AudioWorkletNode(ctx,'volume-meter',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});window.__masters.at(-1).connect(m);m.connect(ctx.destination);window.__volumeMeter=m;
 });
}
export async function readVolumeMeter(page,exclusiveBound=.800001){
 const m=await page.evaluate(()=>new Promise((resolve,reject)=>{const m=window.__volumeMeter,t=setTimeout(()=>reject(Error('volume meter timeout')),5000);m.port.onmessage=e=>{clearTimeout(t);resolve(e.data);};m.port.postMessage('read');}));
 assert(m.frames>0);assert.equal(m.nonfinite,0);assert.equal(m.clipped,0);assert(m.peak.every(p=>p<exclusiveBound));return m;
}
export async function verifyGainAutomation(page){
 const result=await page.evaluate(async()=>{
  const rate=48000,ctx=new OfflineAudioContext(1,rate,rate),source=new ConstantSourceNode(ctx,{offset:.4}),gain=new GainNode(ctx,{gain:0});source.connect(gain).connect(ctx.destination);source.start();
  const changes=[[.1,1],[.25,2],[.26,0],[.27,2],[.5,0]];for(const[t,v]of changes)gain.gain.setTargetAtTime(v,t,.015);
  // Check the first 100 ms of each exponential transition; check final settling separately.
  const audio=(await ctx.startRendering()).getChannelData(0);let level=0,previous=0,target=0,changedAt=0,error=0,step=0,peak=0,worst=null;
  for(let n=0;n<audio.length;n++){const change=changes.find(([t])=>n===Math.round(t*rate));if(change){target=change[1];level=previous;changedAt=n;}const expected=.4*level;if(n-changedAt<4800&&Math.abs(audio[n]-expected)>error){error=Math.abs(audio[n]-expected);worst={n,actual:audio[n],expected};}if(n)step=Math.max(step,Math.abs(audio[n]-audio[n-1]));peak=Math.max(peak,Math.abs(audio[n]));previous=level;level=target+(level-target)*Math.exp(-1/(rate*.015));}
  const stopCtx=new OfflineAudioContext(1,9600,rate),dc=new ConstantSourceNode(stopCtx,{offset:.4}),master=new GainNode(stopCtx,{gain:2});dc.connect(master).connect(stopCtx.destination);dc.start();master.gain.setValueAtTime(2,.1);master.gain.linearRampToValueAtTime(0,.12);const stopped=(await stopCtx.startRendering()).getChannelData(0);let stopError=0,stopStep=0;for(let n=0;n<stopped.length;n++){const expected=n<4800?.8:n<5760?.8*(5760-n)/960:0;stopError=Math.max(stopError,Math.abs(stopped[n]-expected));if(n)stopStep=Math.max(stopStep,Math.abs(stopped[n]-stopped[n-1]));}
  return {error,worst,maxStep:step,peak,final:audio.at(-1),changes,tau:.015,stopError,stopStep,stopFinal:stopped.at(-1)};
 });
 assert(result.stopError<2e-6);assert(result.stopStep<.8/960+2e-6);assert.equal(result.stopFinal,0);assert(result.error<2e-5,JSON.stringify(result));assert(result.maxStep<=.8/(48000*.015)+2e-6);assert(result.peak<1);assert(Math.abs(result.final)<1e-10);return result;
}
