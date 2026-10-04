import { chromium } from 'playwright';
import { preview } from 'vite';
import { readFileSync,writeFileSync,readdirSync,mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
if (process.argv.length !== 5) throw new Error('usage: node tests/probes/filter-browser-timing.mjs BASELINE_CONSUMER CANDIDATE_CONSUMER OUTPUT_DIR');
const roots={baseline:resolve(process.argv[2]),candidate:resolve(process.argv[3])};
const out=resolve(process.argv[4]); mkdirSync(out,{recursive:true});const servers={};const results=[];
// Use disposable, already installed Delay FX consumer fixtures from 7ef7ce6.
// Append only a recorder-free browser entry; processor source and WASM are unchanged.
const entry="window.runTiming = async () => {\n  const context = new AudioContext({ sampleRate: 48000 }); await context.suspend();\n  const settings = { timeLeft: 0.075, timeRight: 0.1, feedback: 0.95, mix: 1, cutoff: 1000, sync: 0, bpm: 120, beatsLeft: 1, beatsRight: 1.5, rate: 2, depth: 0.001, bypass: 0, reset: 0 };\n  const fx = await createNode(context, processor, { initial: settings });\n  const source = new OscillatorNode(context, { frequency: 220 });\n  const gain = new GainNode(context, { gain: 0.05 }), mute = new GainNode(context, { gain: 0 });\n  source.connect(gain).connect(fx.inputs.main); fx.outputs.main.connect(mute); mute.connect(context.destination);\n  source.start(0); await context.resume(); await new Promise(r => setTimeout(r, 12000));\n  await context.suspend(); const result = { sampleRate: context.sampleRate, audioSeconds: context.currentTime, settings };\n  source.stop(); fx.dispose(); await context.close(); return result;\n};\n";
for(const root of Object.values(roots)){
 const file=root+'/main.js';const original=readFileSync(file,'utf8').split('window.runTiming = async')[0];
 writeFileSync(file,original+'\n'+entry);execFileSync('npm',['run','build'],{cwd:root,stdio:'inherit'});
}
const digest=x=>createHash('sha256').update(x).digest('hex');
try{
 for(const [label,root]of Object.entries(roots))servers[label]=await preview({root,configFile:false,preview:{host:'127.0.0.1',port:0}});
 // Alternate order to avoid assigning all early or late trials to one variant.
 for(let trial=0;trial<4;trial++)for(const label of trial%2?['candidate','baseline']:['baseline','candidate']){
  const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
  try{
   const page=await browser.newPage();const cdp=await page.context().newCDPSession(page);
   await cdp.send('Tracing.start',{categories:'disabled-by-default-webaudio.audionode,v8,disabled-by-default-v8.gc,v8.wasm',transferMode:'ReturnAsStream'});
   await page.goto(servers[label].resolvedUrls.local[0]);await page.waitForFunction(()=>typeof window.runTiming==='function');
   const config=await page.evaluate(()=>window.runTiming());
   const done=new Promise(r=>cdp.once('Tracing.tracingComplete',r));await cdp.send('Tracing.end');const {stream}=await done;let raw='';
   for(;;){const r=await cdp.send('IO.read',{handle:stream});raw+=r.base64Encoded?atob(r.data):r.data;if(r.eof)break;}await cdp.send('IO.close',{handle:stream});
   const filename=`${label}-${trial}-trace.json`;writeFileSync(`${out}/${filename}`,raw);
   const events=JSON.parse(raw).traceEvents,w=events.filter(e=>e.name==='AudioWorkletHandler::Process'&&e.dur!==undefined).sort((a,b)=>a.ts-b.ts);
   const stats=values=>{values.sort((a,b)=>a-b);return{meanMs:values.reduce((a,b)=>a+b,0)/values.length,p99Ms:values[Math.floor(.99*(values.length-1))],maxMs:values.at(-1)};};
   const wasmName=readdirSync(roots[label]+'/dist/assets').find(x=>/^processor-.*\.wasm$/.test(x));const wasm=readFileSync(roots[label]+'/dist/assets/'+wasmName);
   const r={label,trial,...config,wasmBytes:wasm.length,wasmSha256:digest(wasm),quanta:w.length,firstWallMs:w[0].dur/1000,firstCpuMs:w[0].tdur/1000,hotWall:stats(w.slice(1).map(x=>x.dur/1000)),hotCpu:stats(w.slice(1).map(x=>x.tdur/1000)),overBudget:w.flatMap((e,q)=>Math.max(e.dur,e.tdur??0)>128/48*1000?[{quantum:q,wallMs:e.dur/1000,cpuMs:e.tdur/1000,clockAnomaly:e.tdur>e.dur+100}]:[]),lazyCompile:events.filter(e=>e.name?.includes('CompileLazy')).map(e=>({name:e.name,dur:e.dur,tdur:e.tdur,withinFirst:e.ts>=w[0].ts&&e.ts<=w[0].ts+w[0].dur})),trace:filename,traceSha256:digest(raw)};
   results.push(r);writeFileSync(`${out}/browser-timing.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(r));
  }finally{await browser.close();}
 }
}finally{for(const server of Object.values(servers))await new Promise(r=>server.httpServer.close(r));}
