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

test('packed experimental resident stretch: exact EOF, coherent interior signals and native live restore',{timeout:180000},async()=>{
 const consumer=mkdtempSync(join(tmpdir(),'den-stretch-browser-')),artifacts=join(root,'artifacts/stretch-browser',new Date().toISOString().replaceAll(':','-'));mkdirSync(artifacts,{recursive:true});
 const sources=['package.json','package-lock.json',...readdirSync(join(root,'src')).filter(x=>x.endsWith('.ts')).map(x=>`src/${x}`),'tests/stretch-browser.test.mjs',...readdirSync(join(root,'tests/stretch-browser-consumer')).map(x=>`tests/stretch-browser-consumer/${x}`)];
 const manifest={status:'CANDIDATE',runtimeStatus:'NOT_CLEARED',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(sources.map(p=>[p,hash(join(root,p))])),checks:{},limitations:['Experimental sparse WSOLA: supported coherent interiors only, no general transparent-quality claim','Exact active duration is not exact nonzero/audible duration; severe padded-tail carrier distortion is retained separately','Native live restore is functional; bit-exact quantum continuation has separate independent offline evidence','No realtime clearance; measured maximum-configuration deadline failures remain mandatory evidence']};
 let server,browser;
 try{
  cpSync(join(root,'tests/consumer'),consumer,{recursive:true});cpSync(join(root,'tests/stretch-browser-consumer'),consumer,{recursive:true});
  writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,allowImportingTsExtensions:true,types:[],lib:['ES2023','DOM']},include:['processor.ts','duration-processor.ts']}));
  const[pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock));manifest.packageIntegrity=pack.integrity;
  run('npm',['ci','--include=dev','--ignore-scripts'],consumer);run('npm',['run','check'],consumer);manifest.checks.types='PASS';
  writeFileSync(join(consumer,'oracle.mjs'),`import assert from'node:assert/strict';import{renderOffline}from'@unworklet/offline';import{makeProcessor}from'./processor.ts';for(const sampleRate of[44100,48000,96000])for(const duration of[.5,1,2]){const processor=makeProcessor(147,44100),expected=Number((147n*BigInt(sampleRate)*BigInt(duration*2)+88200n-1n)/88200n);const r=await renderOffline(processor,{sampleRate,duration:.025,params:{gate:[1],duration:[duration],pitch:[1]},messages:[{name:'load',payload:{data:new Float32Array(147).fill(.25)}}]});assert.equal(r.diagnostics.scrubbedSamples,0);const end=r.outputs.main[0].length-1;assert.equal(r.outputs.main[6][end],expected);assert.equal(r.outputs.main[8][end],expected);assert.equal(r.outputs.main[3][end],1);assert.equal(r.outputs.main[0][end],0);assert(r.outputs.main[7][end]>0);}console.log('Three-rate exact rational duration and native EOF composition passed');`);
  run('node',['oracle.mjs'],consumer);manifest.checks.offline='PASS';run('npm',['run','build'],consumer);manifest.checks.build='PASS';
  manifest.wasm=Object.fromEntries(readdirSync(join(consumer,'dist/assets')).filter(x=>x.endsWith('.wasm')).map(x=>[x,hash(join(consumer,'dist/assets',x))]));
  const{preview}=await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);server=await preview({root:consumer,configFile:false,preview:{host:'127.0.0.1',port:0}});browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>typeof window.runResidentStretch==='function');const r=await page.evaluate(()=>window.runResidentStretch());writeFileSync(join(artifacts,'browser.json'),JSON.stringify(r,null,2));
  assert.equal(r.sampleRate,48000);assert.deepEqual(r.errors.filter(e=>e.code!=='sab-unavailable'),[]);
  for(const a of[...Object.values(r.loaded),...r.duration.map(x=>x.observed),...Object.values(r.tone).filter(Array.isArray)])assert(a.every(x=>x.finite));
  assert.equal(r.loaded.short[9].mean,147);assert.equal(r.loaded.tone[9].mean,65536);assert.equal(r.loaded.short[0].peak,0);assert.equal(r.loaded.tone[0].peak,0);
  // Independent document-law scalar oracle: absolute coordinates and freshly
  // evaluated padded samples; no native/reference implementation is imported.
  const expectedSum=(duration,pitch)=>{const L=147,H=128,S=8,T=Number((147n*48000n*BigInt(duration*2)+88200n-1n)/88200n),q=pitch*44100/48000;let current=0,previous=0,sum=0;
   const at=p=>{const i=Math.floor(p),f=p-i,a=i>=0&&i<L?.25:0,b=i+1>=0&&i+1<L?.25:0;return a*(1-f)+b*f;};
   for(let n=0;n<T;n++){if(n>0&&n%H===0){previous=current+H*q;const nominal=n*L/T;let best=Infinity,offset=0;for(const d of[0,...Array.from({length:S},(_,j)=>[j+1,-j-1]).flat()]){let score=0;for(let j=0;j<64;j++){const x=at(previous+j*H/64*q)-at(nominal+d+j*H/64*q);score+=x*x;}if(score<best){best=score;offset=d;}}current=nominal+offset;}const k=n%H,w=k/H,value=n<H?at(k*q):(1-w)*at(previous+k*q)+w*at(current+k*q);sum+=Math.abs(Math.fround(value));}return{frames:T,sum:Math.fround(sum)};};
  for(const row of r.duration){const a=row.observed,expected=expectedSum(row.duration,row.pitch);assert.equal(a[6].mean,expected.frames,'exact active sample count');assert.equal(a[8].mean,expected.frames,'exact first EOF minus first active frame');assert.equal(a[3].mean,1);assert.equal(a[2].peak,0);assert.equal(a[0].peak,0);near(a[7].mean,expected.sum,'independent accumulated actual signal',3e-5);assert.equal(a[5].peak,0);}
  const t=r.tone;for(const name of['initial','latched']){near(t[name][0].amplitudes[32],.5,`${name} 750Hz carrier`,3e-5);assert(t[name][0].amplitudes[64]<3e-5);assert.equal(t[name][2].mean,1);}
  assert.equal(t.eof[6].mean,32768,'latched duration ignores active edit');assert.equal(t.eof[8].mean,32768);assert.equal(t.eof[3].mean,1);assert.equal(t.eof[0].peak,0);
  for(const name of['retrigger','beforeSave','afterRestore']){near(t[name][0].amplitudes[64],.5,`${name} 1500Hz carrier`,3e-5);assert(t[name][0].amplitudes[32]<3e-5);assert.equal(t[name][2].mean,1);}
  assert.equal(t.replacedHeld[0].peak,0);assert.equal(t.replacedHeld[2].peak,0);assert.equal(t.replacedHeld[9].mean,16384);near(t.replacementPlayed[0].mean,.125,'replacement actual PCM',1e-7);
  assert.equal(t.restored.ok,true);assert.equal(t.afterRestore[9].mean,65536,'persistent resident recovered');assert(t.afterRestore[6].mean>t.beforeSave[6].mean+3000,'saved noninitial source time resumes rather than restart');assert(t.afterRestore[1].mean>t.beforeSave[1].mean+1500,'saved noninitial logical position resumes');
  for(const name of['reset','unloaded']){assert.equal(t[name][0].peak,0);assert.equal(t[name][2].peak,0);assert.equal(t[name][6].peak,0);}assert.equal(t.unloaded[4].mean,1);assert.equal(t.unloaded[9].mean,0);
  manifest.checks.browser='PASS';
 }catch(error){manifest.failure=String(error);throw error;}finally{writeFileSync(join(artifacts,'manifest.json'),JSON.stringify(manifest,null,2));await browser?.close();if(server)await new Promise((yes,no)=>server.httpServer.close(e=>e?no(e):yes()));}
});
