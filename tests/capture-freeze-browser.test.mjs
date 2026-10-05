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

test('packed native take recording and paired freeze/thaw/history in actual 48 kHz worklets',{timeout:180000},async()=>{
 const consumer=mkdtempSync(join(tmpdir(),'den-capture-freeze-browser-')),artifacts=join(root,'artifacts/capture-freeze-browser',new Date().toISOString().replaceAll(':','-'));mkdirSync(artifacts,{recursive:true});
 const sources=['package.json','package-lock.json',...readdirSync(join(root,'src')).filter(x=>x.endsWith('.ts')).map(x=>`src/${x}`),'tests/capture-freeze-browser.test.mjs',...readdirSync(join(root,'tests/capture-freeze-browser-consumer')).map(x=>`tests/capture-freeze-browser-consumer/${x}`)];
 const manifest={status:'CANDIDATE',runtimeStatus:'NOT_CLEARED',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(sources.map(p=>[p,hash(join(root,p))])),checks:{},limitations:['Native generated graph input only; no microphone or device permission','Small browser functional graph, not deadline or indefinite-energy preservation proof','Stored-energy drift and exact history continuation remain independent offline evidence','Record pauses do not add frames; native composition limits remove host-timer capture ambiguity']};
 let server,browser;
 try{
  cpSync(join(root,'tests/consumer'),consumer,{recursive:true});cpSync(join(root,'tests/capture-freeze-browser-consumer'),consumer,{recursive:true});
  writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,allowImportingTsExtensions:true,types:[],lib:['ES2023','DOM']},include:['recorder-processor.ts','freeze-processor.ts']}));
  const[pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock));manifest.packageIntegrity=pack.integrity;
  run('npm',['ci','--include=dev','--ignore-scripts'],consumer);run('npm',['run','check'],consumer);manifest.checks.types='PASS';
  writeFileSync(join(consumer,'oracle.mjs'),`import assert from'node:assert/strict';import{renderOffline}from'@unworklet/offline';import recorder from'./recorder-processor.ts';import freeze from'./freeze-processor.ts';for(const sampleRate of[44100,48000,96000]){const r=await renderOffline(recorder,{sampleRate,duration:.02,params:{record:[1],limit:[64],play:[1]}});assert.equal(r.diagnostics.scrubbedSamples,0);for(let n=256;n<r.outputs.main[0].length;n++){assert.equal(r.outputs.main[0][n],64);assert.equal(r.outputs.main[1][n],.25);assert.equal(r.outputs.main[2][n],.25);assert.equal(r.outputs.main[6][n],.25);}const f=await renderOffline(freeze,{sampleRate,duration:.12});assert.equal(f.diagnostics.scrubbedSamples,0);assert(f.outputs.main[0].some(x=>Math.abs(x)>.00001));assert.deepEqual(f.outputs.main[0],f.outputs.main[2]);assert.deepEqual(f.outputs.main[1],f.outputs.main[3]);}console.log('Three-rate native capture and paired freeze composition passed');`);
  run('node',['oracle.mjs'],consumer);manifest.checks.offline='PASS';run('npm',['run','build'],consumer);manifest.checks.build='PASS';
  manifest.wasm=Object.fromEntries(readdirSync(join(consumer,'dist/assets')).filter(x=>x.endsWith('.wasm')).map(x=>[x,hash(join(consumer,'dist/assets',x))]));
  const{preview}=await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);server=await preview({root:consumer,configFile:false,preview:{host:'127.0.0.1',port:0}});browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>typeof window.runCaptureFreeze==='function');const r=await page.evaluate(()=>window.runCaptureFreeze());writeFileSync(join(artifacts,'browser.json'),JSON.stringify(r,null,2));
  assert.equal(r.sampleRate,48000);assert.deepEqual(r.errors.filter(e=>e.code!=='sab-unavailable'),[]);
  const take=r.recorder;assert.equal(take.restored.ok,true);
  for(const a of Object.values(take).filter(Array.isArray))assert(a.every(x=>x.finite));
  for(const[name,length,first,last]of[['empty',0,0,0],['firstTake',64,.25,.25],['firstPlayback',64,.25,.25],['paused',64,.25,.25],['appended',128,.25,-.5],['boundary',128,.25,-.5],['full',256,.25,.75],['fullUnchanged',256,.25,.75],['fullPlayback',256,.25,.75],['reset',0,0,0],['overwritten',256,-.75,-.75],['afterRestore',256,.25,.75],['prefix',2,1,.5],['prefixAppend',4,1,-.5]]){const a=take[name];near(a[0].mean,length,`${name} length`,1e-7);near(a[1].mean,first,`${name} first frame`,1e-7);near(a[2].mean,last,`${name} last frame`,1e-7);assert.equal(a[4].peak,0,`${name} recording settled at pause/limit/full`);assert.equal(a[5].mean,+(length===256));}
  near(take.appended[3].mean,.25,'old segment boundary',1e-7);near(take.boundary[3].mean,-.5,'appended segment boundary',1e-7);near(take.afterRestore[3].mean,-.5,'restored overwritten PCM',1e-7);near(take.prefixAppend[3].mean,0,'loaded-prefix/recorded-suffix interpolation',1e-7);
  near(take.firstPlayback[6].mean,.25,'native player reads take',1e-7);for(const name of['fullPlayback','afterRestore']){near(take[name][6].mean,.3125,`${name} complete256-frame loop mean`,1e-7);near(take[name][6].peak,.75,`${name} playback peak`,1e-7);}assert.equal(take.reset[6].peak,0);
  const f=r.freeze;assert.equal(f.restored.ok,true);for(const a of Object.values(f).filter(Array.isArray))assert(a.every(x=>x.finite));
  for(const name of['live','frozen','inputBlocked','afterRestore'])assert(f[name][0].rms>1e-5&&f[name][1].rms>1e-5,`${name} nonzero wet history`);
  for(const name of['frozen','inputBlocked','afterRestore','emptyFrozen']){assert.equal(f[name][4].mean,1);assert.equal(f[name][5].mean,1);}
  for(const name of['live','frozen','inputBlocked','afterRestore']){assert.equal(f[name][6].peak,0,`${name} exact paired left`);assert.equal(f[name][7].peak,0,`${name} exact paired right`);}
  assert.equal(f.thawed[4].peak,0);assert.equal(f.thawed[5].peak,0);for(const ch of[0,1,2,3])assert(f.thawed[ch].peak<1e-6,'unforced thaw decays');
  for(const name of['reset','resetRestored','emptyFrozen'])for(const ch of[0,1,2,3,6,7])assert.equal(f[name][ch].peak,0,`${name} silent history`);
  assert.equal(f.reset[4].peak,0);assert.equal(f.resetRestored[4].peak,0);assert(f.mutated[0].rms>1e-5||f.mutated[1].rms>1e-5);assert.equal(f.mutated[2].peak,0);assert.equal(f.mutated[3].peak,0);assert(f.mutated[6].peak>1e-5||f.mutated[7].peak>1e-5,'live unequal input must separate the two histories before restore');
  manifest.checks.browser='PASS';
 }catch(error){manifest.failure=String(error);throw error;}finally{writeFileSync(join(artifacts,'manifest.json'),JSON.stringify(manifest,null,2));await browser?.close();if(server)await new Promise((yes,no)=>server.httpServer.close(e=>e?no(e):yes()));}
});
