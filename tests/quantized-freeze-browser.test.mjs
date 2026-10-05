import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,copyFileSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
const root=join(import.meta.dirname,'..'),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const run=(cmd,args,cwd)=>execFileSync(cmd,cmd==='npm'?['--cache',join(tmpdir(),'den-npm-cache'),...args]:args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024});
const near=(a,b,label,tolerance=3e-5)=>assert(Math.abs(a-b)<tolerance,`${label}: ${a} vs ${b}`);

test('packed musical quantizer and bin-centered spectral freeze in actual 48 kHz worklets',{timeout:180000},async()=>{
 const consumer=mkdtempSync(join(tmpdir(),'den-quantized-freeze-browser-')),artifacts=join(root,'artifacts/quantized-freeze-browser',new Date().toISOString().replaceAll(':','-'));mkdirSync(artifacts,{recursive:true});
 const sources=['package.json','package-lock.json',...readdirSync(join(root,'src')).filter(x=>x.endsWith('.ts')).map(x=>`src/${x}`),'tests/quantized-freeze-browser.test.mjs',...readdirSync(join(root,'tests/quantized-freeze-browser-consumer')).map(x=>`tests/quantized-freeze-browser-consumer/${x}`)];
 const manifest={status:'CANDIDATE',consumerRetention:'Only this newly created consumer node_modules is removed after cleanup; lock, tarball, fixtures, built outputs and evidence remain',runtimeStatus:'NOT_CLEARED',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(sources.map(p=>[p,hash(join(root,p))])),checks:{},limitations:['Small control and N64 spectral composition only; no capacity/realtime or listening approval','Held spectra retain captured-window modulation and produce an N-periodic texture, not phase-vocoder transparency','Live restores first render identical saved controls; persistent state mutation remains observable before restore','Exact full quantum continuation and all rates/capacities retain separate independent component evidence']};
 let server,browser;
 try{
  cpSync(join(root,'tests/consumer'),consumer,{recursive:true});cpSync(join(root,'tests/quantized-freeze-browser-consumer'),consumer,{recursive:true});
  writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,allowImportingTsExtensions:true,types:[],lib:['ES2023','DOM']},include:['processor.ts']}));
  const[pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock));manifest.packageIntegrity=pack.integrity;
  run('npm',['ci','--include=dev','--ignore-scripts'],consumer);run('npm',['run','check'],consumer);manifest.checks.types='PASS';
  writeFileSync(join(consumer,'oracle.mjs'),`import assert from'node:assert/strict';import{renderOffline}from'@unworklet/offline';import processor from'./processor.ts';const N=64,H=16,envelope=t=>.25*Math.sin(Math.PI*(t%N)/N)*(2*H/N)*Array.from({length:N/H},(_,j)=>Math.sin(Math.PI*((t%H)+j*H)/N)).reduce((a,b)=>a+b,0);for(const sampleRate of[44100,48000,96000]){const frames=2048,r=await renderOffline(processor,{sampleRate,duration:(frames-.25)/sampleRate,params:{pitch:Array.from({length:frames},(_,n)=>n<128?63:61.5),freeze:Array.from({length:frames},(_,n)=>+(n>=512&&n<1536))}});assert.equal(r.diagnostics.scrubbedSamples,0);for(let n=256;n<frames;n++){assert.equal(r.outputs.main[4][n],63);assert.equal(r.outputs.main[5][n],1);assert.equal(r.outputs.main[6][n],5);assert.equal(r.outputs.main[7][n],60);if(n<512||n>=1664)assert.equal(r.outputs.main[0][n],.25);else if(n>=640&&n<1536)assert(Math.abs(r.outputs.main[0][n]-envelope(n-512))<2e-7);}assert(r.outputs.main.every(c=>c.every(Number.isFinite)));}console.log('Three-rate independent quantizer and circular-window spectral-envelope composition passed');`);
  run('node',['oracle.mjs'],consumer);manifest.checks.offline='PASS';run('npm',['run','build'],consumer);manifest.checks.build='PASS';
  manifest.wasm=Object.fromEntries(readdirSync(join(consumer,'dist/assets')).filter(x=>x.endsWith('.wasm')).map(x=>[x,hash(join(consumer,'dist/assets',x))]));
  const{preview}=await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);server=await preview({root:consumer,configFile:false,preview:{host:'127.0.0.1',port:0}});browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>typeof window.runQuantizedFreeze==='function');const r=await page.evaluate(()=>window.runQuantizedFreeze());writeFileSync(join(artifacts,'browser.json'),JSON.stringify(r,null,2));
  assert.equal(r.sampleRate,48000);assert.deepEqual(r.errors.filter(e=>e.code!=='sab-unavailable'),[]);
  const q=r.quantizer,f=r.spectral;for(const a of[...Object.values(q),...Object.values(f)].filter(Array.isArray))assert(a.every(x=>x.finite));
  const expectQ=(name,hp,hd,ho,np,nd,no)=>{const a=q[name];for(const[ch,value]of[[4,hp],[5,hd],[6,ho],[7,np],[8,nd],[9,no]])near(a[ch].mean,value,`${name} quantizer channel${ch}`,1e-7);};
  expectQ('initial',60,0,5,60,0,5);expectQ('inside',60,0,5,63,1,5);expectQ('upperEquality',60,0,5,63,1,5);expectQ('upperOutside',63,1,5,63,1,5);expectQ('lowerEquality',63,1,5,60,0,5);expectQ('lowerOutside',60,0,5,60,0,5);
  expectQ('beforeSave',63,1,5,60,0,5);expectQ('mutated',60,0,5,60,0,5);expectQ('controlsPrepared',60,0,5,60,0,5);expectQ('afterRestore',63,1,5,60,0,5);expectQ('resetHeld',60,0,5,60,0,5);expectQ('negative',-5,2,-1,-5,2,-1);
  assert.equal(q.restored.ok,true);for(const name of['beforeSave','controlsPrepared','afterRestore']){assert.equal(q[name][10].mean,61.5);assert.equal(q[name][11].mean,0);assert.equal(q[name][1].mean,.25);assert.equal(q[name][2].mean,0);assert.equal(q[name][3].mean,0);}
  // For captured constant c, positive bin rotations are circular left shifts
  // of c*sin(pi*n/N). In steady WOLA the analysis term is common to every
  // overlapping frame, leaving this closed-form, nonconstant N-periodic envelope.
  // Capture time is asynchronous; compare all integer cyclic phases, not a
  // fitted amplitude or a constant/RMS-only approximation.
  const pattern=c=>Array.from({length:64},(_,t)=>c*Math.sin(Math.PI*t/64)*.5*Array.from({length:4},(_,j)=>Math.sin(Math.PI*((t%16)+16*j)/64)).reduce((a,b)=>a+b,0));
  const expectFrozen=(name,c)=>{const a=f[name][0],expected=pattern(c);let error=Infinity;for(let shift=0;shift<64;shift++){let maximum=0;for(let n=0;n<64;n++)maximum=Math.max(maximum,Math.abs(a.period[n]-expected[(n+shift)%64]));error=Math.min(error,maximum);}assert(error<3e-6,`${name} independent periodic waveform error ${error}`);assert(a.periodicityError<3e-6,`${name} native N-periodicity`);assert(Math.max(...a.period)-Math.min(...a.period)>.1,`${name} contains expected window modulation`);};
  near(f.live[0].mean,.25,'live identity DC',1e-7);near(f.live[0].peak,.25,'live identity peak',1e-7);expectFrozen('held',.25);expectFrozen('inputChanged',.25);near(f.released[0].mean,-.125,'released latest live frame',1e-7);expectFrozen('negativeCapture',-.125);expectFrozen('controlsPrepared',-.125);expectFrozen('afterRestore',.25);assert.equal(f.restored.ok,true);
  for(const name of['inputChanged','controlsPrepared','afterRestore'])for(const[ch,value]of[[1,.75],[2,1],[3,0],[10,61.5],[11,0]])assert.equal(f[name][ch].mean,value,`${name} rendered saved control ${ch}`);
  for(const name of['reset','emptyHeld']){assert.equal(f[name][0].peak,0);assert.equal(f[name][1].mean,0);assert.equal(f[name][2].mean,1);}assert.equal(f.reset[3].mean,1);assert.equal(f.emptyHeld[3].mean,0);
  manifest.checks.browser='PASS';
 }catch(error){manifest.failure=String(error);throw error;}finally{writeFileSync(join(artifacts,'manifest.json'),JSON.stringify(manifest,null,2));await browser?.close();if(server)await new Promise((yes,no)=>server.httpServer.close(e=>e?no(e):yes()));rmSync(join(consumer,'node_modules'),{recursive:true,force:true});}
});
