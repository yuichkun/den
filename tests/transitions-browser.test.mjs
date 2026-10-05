import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,copyFileSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
const root=join(import.meta.dirname,'..'),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const run=(cmd,args,cwd)=>execFileSync(cmd,cmd==='npm'?['--cache',join(tmpdir(),'den-npm-cache'),...args]:args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024});
const near=(a,b,label,tolerance=3e-5)=>assert(Math.abs(a-b)<tolerance,`${label}: ${a} vs ${b}`);
const multiply=(a,b)=>({re:a.re*b.re-a.im*b.im,im:a.re*b.im+a.im*b.re});
function driveResponse(){
 // Literal two-FIR convolution and host-phase decimation, independent of the
 // implementation's polyphase graph. Input stays below hard clipping here.
 const h=Array.from({length:65},(_,k)=>{if(k===0||k===64)return 0;const u=(k-32)*.45;return .45*(u===0?1:Math.sin(Math.PI*u)/(Math.PI*u))*(.42-.5*Math.cos(2*Math.PI*k/64)+.08*Math.cos(4*Math.PI*k/64));});
 const dc=h.reduce((s,v)=>s+v,0);for(let i=0;i<h.length;i++)h[i]/=dc;
 const g=Array.from({length:65},(_,n)=>2*h.reduce((s,v,k)=>s+v*(h[2*n-k]??0),0));
 return g.reduce((s,v,n)=>({re:s.re+v*Math.cos(2*Math.PI*n/128),im:s.im-v*Math.sin(2*Math.PI*n/128)}),{re:0,im:0});
}
function delayed(x,samples){return multiply(x,{re:Math.cos(2*Math.PI*samples/128),im:-Math.sin(2*Math.PI*samples/128)});}

test('packed transition, oversampling, spectral and member-expression controls in actual 48 kHz worklets',{timeout:180000},async()=>{
 const consumer=mkdtempSync(join(tmpdir(),'den-transitions-browser-')),artifacts=join(root,'artifacts/transitions-browser',new Date().toISOString().replaceAll(':','-'));mkdirSync(artifacts,{recursive:true});
 const sources=['package.json','package-lock.json',...readdirSync(join(root,'src')).filter(x=>x.endsWith('.ts')).map(x=>`src/${x}`),'tests/transitions-browser.test.mjs',...readdirSync(join(root,'tests/transitions-browser-consumer')).map(x=>`tests/transitions-browser-consumer/${x}`)];
 const manifest={status:'CANDIDATE',runtimeStatus:'NOT_CLEARED',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(sources.map(p=>[p,hash(join(root,p))])),checks:{},limitations:['Small N256/factor2/one-voice browser functional graph, not maximum-capacity or deadline clearance','Snapshot restores native parameters; exact module-history and hop-phase continuation are independently proved offline','Pitch frequency probes are coherent cases, not arbitrary-input pitch quality','MPE is only a manually configured lower-zone expression subset; no master-pedal or hardware guarantee']};
 let server,browser;
 try{
  cpSync(join(root,'tests/consumer'),consumer,{recursive:true});cpSync(join(root,'tests/transitions-browser-consumer'),consumer,{recursive:true});
  writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,allowImportingTsExtensions:true,types:[],lib:['ES2023','DOM']},include:['processor.ts','mpe-processor.ts','mpe-composition.ts','wave-processor.ts']}));
  const[pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock));manifest.packageIntegrity=pack.integrity;
  run('npm',['ci','--include=dev','--ignore-scripts'],consumer);run('npm',['run','check'],consumer);manifest.checks.types='PASS';
  writeFileSync(join(consumer,'oracle.mjs'),`import assert from'node:assert/strict';import{renderOffline}from'@unworklet/offline';import processor from'./processor.ts';for(const sampleRate of[44100,48000,96000]){const r=await renderOffline(processor,{sampleRate,duration:.1});assert.equal(r.diagnostics.scrubbedSamples,0);for(const x of r.outputs.main)assert(x.every(Number.isFinite));for(let n=4096;n<r.outputs.main[0].length;n++){assert(Math.abs(r.outputs.main[4][n]-r.outputs.main[0][n-256])<2e-6);assert(Math.abs(r.outputs.main[3][n]-r.outputs.main[0][n-1025])<2e-6);}}console.log('Three-rate bounded transition composition passed');`);
  run('node',['oracle.mjs'],consumer);manifest.checks.offline='PASS';run('npm',['run','build'],consumer);manifest.checks.build='PASS';
  manifest.wasm=Object.fromEntries(readdirSync(join(consumer,'dist/assets')).filter(x=>x.endsWith('.wasm')).map(x=>[x,hash(join(consumer,'dist/assets',x))]));
  const{preview}=await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);server=await preview({root:consumer,configFile:false,preview:{host:'127.0.0.1',port:0}});browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>typeof window.runTransitions==='function');const r=await page.evaluate(()=>window.runTransitions());writeFileSync(join(artifacts,'browser.json'),JSON.stringify(r,null,2));
  assert.equal(r.sampleRate,48000);assert.equal(r.restored.ok,true);assert.deepEqual(r.errors.filter(e=>e.code!=='sab-unavailable'),[]);
  const transfer=driveResponse();
  for(const[name,gain,delay]of[['initial',1,8],['up',2,24],['downDry',1,24],['afterRestore',1,8]]){
   const a=r[name];assert(a.every(x=>x.finite));near(a[0].bins[2].amplitude,.125,`${name} source`);const drive=multiply(a[0].bins[2],{re:transfer.re*gain,im:transfer.im*gain});near(a[1].bins[2].re,drive.re,`${name} FIR real`);near(a[1].bins[2].im,drive.im,`${name} FIR phase`);
   const time=delayed(a[0].bins[2],Math.fround(delay/48000)*48000);near(a[2].bins[2].re,time.re,`${name} settled fixed-head real`);near(a[2].bins[2].im,time.im,`${name} settled fixed-head phase`);
   near(a[4].bins[2].re,a[0].bins[2].re,`${name} N256 identity real`);near(a[4].bins[2].im,a[0].bins[2].im,`${name} N256 identity phase`);
  }
  for(const name of['initial','afterRestore']){const expected=delayed(r[name][0].bins[2],1025);near(r[name][3].bins[2].re,expected.re,`${name} unity pitch delay real`);near(r[name][3].bins[2].im,expected.im,`${name} unity pitch delay phase`);}
  near(r.up[3].bins[4].amplitude,.125,'coherent doubled pitch');assert(r.up[3].bins[2].amplitude<1e-5);
  near(r.downDry[3].bins[1].amplitude,.125,'coherent halved pitch',2e-4);assert(r.downDry[3].bins[2].amplitude<1e-5);
  for(const x of r.reset)assert.equal(x.peak,0);
  const m=r.mpe,base=.5*(.5+.5*64/127);assert.equal(m.restored.ok,true);
  for(const[name,hz,bin,level]of[['note',375,2,base],['member',750,4,base],['summed',375,2,base],['expressive',375,2,1],['sustained',375,2,1],['fresh',375,2,base]]){const a=m[name];assert(a.every(x=>x.finite));near(a[1].mean,hz,`${name} pitch`);near(a[2].mean,level,`${name} level`);near(a[0].bins[bin].amplitude,.2*level,`${name} actual audio`);}
  for(const name of['quiet','released','afterRestore','panic'])assert(m[name][0].peak===0,`${name} no orphan voice`);
  const w=r.wave;assert.equal(w.restored.ok,true);
  for(const a of Object.values(w).filter(Array.isArray))assert(a.every(x=>x.finite));
  for(const name of['absent','short']){assert.equal(w[name][0].peak,0);assert.equal(w[name][1].mean,1);}
  for(const name of['low','high','morphed','afterRestore','reset'])assert.equal(w[name][1].peak,0);
  for(const[h,amplitude]of[[1,.1],[3,.05],[7,.025]])near(w.low[0].bins[2*h].amplitude,amplitude*Math.cos(Math.PI*h/128)**2,`prepared low harmonic ${h}`);
  near(w.high[0].bins[64].amplitude,.1,'prepared high pitch rejects folding third/seventh harmonics');near(w.high[0].mean,0,'high frame0 DC');
  for(const name of['morphed','afterRestore']){near(w[name][0].bins[64].amplitude,.2,`${name} native frame edit`);near(w[name][0].mean,.02,`${name} frame DC`);}
  near(w.reset[0].mean,.02,'held reset emits frame1 phase0 DC');near(w.reset[0].peak,.02,'held reset static phase');
  manifest.checks.browser='PASS';
 }catch(error){manifest.failure=String(error);throw error;}finally{writeFileSync(join(artifacts,'manifest.json'),JSON.stringify(manifest,null,2));await browser?.close();if(server)await new Promise((yes,no)=>server.httpServer.close(e=>e?no(e):yes()));}
});
