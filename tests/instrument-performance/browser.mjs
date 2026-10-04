// Manual browser controls; all trials and failures are retained, never a golden.
import {build,preview} from 'vite';
import unworklet from '@unworklet/unplugin';
import {chromium} from 'playwright';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,copyFileSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {cpus} from 'node:os';
const root=process.cwd(),runId=new Date().toISOString().replaceAll(':','-'),out=resolve('artifacts/instrument-investigation',runId+'-browser');mkdirSync(out,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const files=['src/instrument.ts','src/voice-policy.ts','src/oscillator.ts','src/filter.ts','src/lfo.ts','src/envelope.ts','package-lock.json','tests/instrument-performance/browser.mjs',...readdirSync('tests/instrument-performance/browser').filter(f=>statSync('tests/instrument-performance/browser/'+f).isFile()).map(f=>'tests/instrument-performance/browser/'+f)];
const sourceHashes=Object.fromEntries(files.map(f=>[f,hash(readFileSync(f))]));
for(const f of files){const target=join(out,'source',f);mkdirSync(resolve(target,'..'),{recursive:true});copyFileSync(f,target);}
let fixtureRoot=resolve('tests/instrument-performance/browser');
let proposalSource=null;
if(process.env.CONTROL_MODE==='owned'){
 proposalSource=resolve(process.env.PROPOSALS_DIR);fixtureRoot=join(out,'fixture');mkdirSync(fixtureRoot,{recursive:true});
 copyFileSync('tests/instrument-performance/browser/index.html',join(fixtureRoot,'index.html'));
 let main=readFileSync('tests/instrument-performance/browser/main.js','utf8').replace(/^import (one|four|sixteen|oscillator) from .*;$/gm,'').replace('const processors={one,four,sixteen,oscillator};','const processors={};');
 for(const name of ['baseline','depths'])for(const capacity of [1,4]){
  const kind=name+'-'+capacity,identifier=name+capacity;
  writeFileSync(join(fixtureRoot,kind+'.ts'),`import {createInstrument} from ${JSON.stringify(join(proposalSource,name,'dist/instrument.js'))}; export const processor=createInstrument({mode:'poly',capacity:${capacity},heldCapacity:128});`);
  main+=`\nimport ${identifier} from './${kind}.ts?worklet'; processors['${kind}']=${identifier};\n`;
 }
 writeFileSync(join(fixtureRoot,'main.js'),main);
 for(const f of readdirSync(fixtureRoot))sourceHashes['generated-fixture/'+f]=hash(readFileSync(join(fixtureRoot,f)));
 sourceHashes['proposal-manifest']=hash(readFileSync(join(proposalSource,'manifest.json')));
}
const config={root:fixtureRoot,configFile:false,plugins:[unworklet()],build:{outDir:join(out,'build'),emptyOutDir:false},logLevel:'warn'};
await build(config);
const wasm=Object.fromEntries(readdirSync(join(out,'build/assets')).filter(f=>f.endsWith('.wasm')).map(f=>{const bytes=readFileSync(join(out,'build/assets',f));return [f,{bytes:bytes.length,sha256:hash(bytes)}];}));
const server=await preview({...config,preview:{host:'127.0.0.1',port:0}});
const manifest={runId,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceDirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()!=='',sourceHashes,wasm,proposalSource,caseFilter:process.env.CASE_FILTER??null,traceGc:Boolean(process.env.TRACE_GC),traceEnabled:!process.env.NO_TRACE,cpu:cpus()[0]?.model,node:process.version,cases:[],limitation:'Muted graph capture and Chrome render-thread trace; no hardware loopback. A failed trial or counterexample is retained and never retried in place.'};
const settings=process.env.CONTROL_MODE==='owned'?['baseline','depths'].flatMap(name=>[1,4].map(capacity=>({kind:name+'-'+capacity,active:capacity,poll:true}))):process.env.CONTROL_MODE==='unobserved'?[{kind:'native-unobserved'},{kind:'oscillator-unobserved'},{kind:'four-unobserved'}]:[{kind:'native-counter',poll:false},{kind:'native-counter',poll:true},{kind:'oscillator',poll:true},{kind:'one',active:1,poll:true},{kind:'four',active:0,poll:true},{kind:'four',active:4,poll:true},{kind:'sixteen',active:16,poll:true}];
let browser;
const summarize=events=>{const qs=key=>{const v=events.map(e=>e[key]).filter(Number.isFinite).sort((a,b)=>a-b);return {count:v.length,mean:v.reduce((a,b)=>a+b,0)/v.length,p50:v[Math.floor(v.length*.5)],p99:v[Math.floor(v.length*.99)],max:v.at(-1),overBudget:v.length?v.filter(x=>x>128/48000*1e6).length:null};};return {wallUs:qs('dur'),threadCpuUs:qs('tdur')};};
try{
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});manifest.browser=browser.version();
 for(let trial=0;trial<Number(process.env.TRIALS??3);trial++)for(const setting of settings.filter(s=>!process.env.CASE_FILTER||new RegExp(process.env.CASE_FILTER).test(s.kind))){
  const id=`trial${trial}-${setting.kind}-active${setting.active??0}-poll${Number(Boolean(setting.poll))}`,page=await browser.newPage(),session=await browser.newBrowserCDPSession();
  await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>typeof window.diagnosticRun==='function');
  const cpuBefore=await session.send('SystemInfo.getProcessInfo');
  if(!process.env.NO_TRACE)await session.send('Tracing.start',{categories:'audio,webaudio,disabled-by-default-audio,disabled-by-default-audio-worklet,disabled-by-default-audio.latency'+(process.env.TRACE_GC?',v8,disabled-by-default-v8.gc':''),transferMode:'ReturnAsStream'});
  let result,failure;const started=Date.now();try{result=await page.evaluate(s=>(s.kind.endsWith('-unobserved')?window.diagnosticUnobserved:window.diagnosticRun)({...s,seconds:12}),setting);}catch(e){failure=String(e);}
  const cpuAfter=await session.send('SystemInfo.getProcessInfo');
  let traceText=JSON.stringify({traceEvents:[]});
  if(!process.env.NO_TRACE){
   const finished=new Promise(r=>session.once('Tracing.tracingComplete',r));await session.send('Tracing.end');const stream=(await finished).stream;traceText='';
   for(;;){const part=await session.send('IO.read',{handle:stream});traceText+=part.data;if(part.eof)break;}await session.send('IO.close',{handle:stream});
  }
  writeFileSync(join(out,id+'-trace.json.gz'),gzipSync(traceText));
  const trace=JSON.parse(traceText),events=trace.traceEvents.filter(e=>e.name==='RealtimeAudioDestinationHandler::Render'&&e.ph==='X'&&e.args?.frames===128);
  const report={id,trial,setting,failure,cpuBefore,cpuAfter,traceEnabled:!process.env.NO_TRACE,wallElapsedMs:Date.now()-started,timing:{all:summarize(events),steady:summarize(events.slice(375))},traceHash:hash(gzipSync(traceText))};
  writeFileSync(join(out,id+'-render-timing.json'),JSON.stringify(events.map(({ts,dur,tts,tdur,pid,tid,args})=>({ts,dur,tts,tdur,pid,tid,args}))));
  if(result){
   const audio=result.raw.map(x=>Float32Array.from(x));delete result.raw;
   report.createNodeMs=result.createNodeMs;report.playback=result.playback;report.graphWallElapsedMs=result.wallElapsedMs;report.observationMode=result.observationMode??'full raw capture';
   report.rawHashes=audio.map((a,c)=>{const bytes=new Uint8Array(a.buffer);writeFileSync(join(out,`${id}-channel${c}.f32`),bytes);return hash(bytes);});
   const gaps=[],intra=[];for(let q=0;q<result.entry.length;q++){if(q&&result.entry[q]!==result.entry[q-1]+128)gaps.push({q,previous:result.entry[q-1],entry:result.entry[q]});if(result.entry[q]!==result.exit[q])intra.push({q,entry:result.entry[q],exit:result.exit[q]});}
   let counterBreaks=setting.kind==='native-counter'?0:null,counterMaxError=setting.kind==='native-counter'?0:null;
   if(setting.kind==='native-counter'){const first=Math.round(audio[1][0]*1048576);for(let n=0;n<audio[1].length;n++){const err=Math.abs(Math.round(audio[1][n]*1048576)-(first+n));if(err)counterBreaks++;counterMaxError=Math.max(counterMaxError,err);}}
   const omega=2*Math.PI*440/48000;let cc=0,ss=0,cs=0,xc=0,xs=0;
   for(let n=0;n<4096;n++){const c=Math.cos(omega*n),s=Math.sin(omega*n),x=audio[0][n];cc+=c*c;ss+=s*s;cs+=c*s;xc+=x*c;xs+=x*s;}
   const det=cc*ss-cs*cs,c=(xc*ss-xs*cs)/det,s=(xs*cc-xc*cs)/det;let residual=0,maxStep=0;
   for(let n=0;n<audio[0].length;n++){residual=Math.max(residual,Math.abs(audio[0][n]-c*Math.cos(omega*n)-s*Math.sin(omega*n)));if(n)maxStep=Math.max(maxStep,Math.abs(audio[0][n]-audio[0][n-1]));}
   report.observation={gaps,intraFrameChanges:intra,counterBreaks,counterMaxError,amplitude:Math.hypot(c,s),residual,maxStep,finite:audio.every(a=>a.every(Number.isFinite)),lengths:[...new Set(result.lengths)]};
   writeFileSync(join(out,id+'-observation.json'),JSON.stringify(result));
  }
  writeFileSync(join(out,id+'-summary.json'),JSON.stringify(report,null,2));manifest.cases.push(report);writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));
  console.log(JSON.stringify(report));await page.close();await session.detach();
 }
}finally{await browser?.close();await new Promise(r=>server.httpServer.close(r));}
console.log('Evidence:',out);
