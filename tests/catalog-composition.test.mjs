import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,copyFileSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
const root=join(import.meta.dirname,'..'),hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const run=(command,args,cwd)=>execFileSync(command,command==='npm'?['--cache',join(tmpdir(),'den-npm-cache'),...args]:args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024});
test('packed catalog drive/dynamics and modulation/reverb in actual 48 kHz worklets', {timeout:180000},async()=>{
 const consumer=mkdtempSync(join(tmpdir(),'den-catalog-browser-')),artifacts=join(root,'artifacts/catalog-composition',new Date().toISOString().replaceAll(':','-'));mkdirSync(artifacts,{recursive:true});
 const files=['package.json','package-lock.json',...readdirSync(join(root,'src')).filter(path=>path.endsWith('.ts')).map(path=>`src/${path}`),'tests/catalog-modulation-consumer/processor.ts','tests/catalog-composition.test.mjs',...readdirSync(join(root,'tests/catalog-browser-consumer')).map(path=>`tests/catalog-browser-consumer/${path}`)];
 const manifest={status:'CANDIDATE',runtimeStatus:'NOT_CLEARED',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(files.map(path=>[path,hash(join(root,path))])),checks:{}};
 let server,browser;
 try{
  cpSync(join(root,'tests/consumer'),consumer,{recursive:true});cpSync(join(root,'tests/catalog-browser-consumer'),consumer,{recursive:true});copyFileSync(join(root,'tests/catalog-modulation-consumer/processor.ts'),join(consumer,'fx-processor.ts'));
  writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,types:[],lib:['ES2023','DOM']},include:['processor.ts','fx-processor.ts']}));
  const [pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock));manifest.packageIntegrity=pack.integrity;
  run('npm',['ci','--include=dev','--ignore-scripts'],consumer);run('npm',['run','check'],consumer);manifest.checks.publicTypes='PASS';
  writeFileSync(join(consumer,'oracle.mjs'),`import assert from 'node:assert/strict';import{renderOffline}from'@unworklet/offline';import processor from'./processor.ts';for(const sampleRate of[44100,48000,96000]){const r=await renderOffline(processor,{sampleRate,duration:(512-.5)/sampleRate,inputs:{main:[new Float32Array(512).fill(.25)]}});assert.equal(r.diagnostics.scrubbedSamples,0);for(const[ch,value]of[[0,1],[1,.25],[2,10**(-13.5/20)],[3,-(10**(-13.5/20))]])for(const x of r.outputs.main[ch].subarray(256))assert(Math.abs(x-value)<2e-6);}console.log('Three-rate analytic composition oracle passed');`);
  run('node',['oracle.mjs'],consumer);manifest.checks.offline='PASS';run('npm',['run','build'],consumer);manifest.checks.build='PASS';manifest.wasm=Object.fromEntries(readdirSync(join(consumer,'dist/assets')).filter(path=>path.endsWith('.wasm')).map(path=>[path,hash(join(consumer,'dist/assets',path))]));
  const{preview}=await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);server=await preview({root:consumer,configFile:false,preview:{host:'127.0.0.1',port:0}});
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>typeof window.runCatalogComposition==='function');const result=await page.evaluate(()=>window.runCatalogComposition());writeFileSync(join(artifacts,'browser.json'),JSON.stringify(result,null,2));
  assert.equal(result.sampleRate,48000);for(const key of ['compressed','open','afterRestore','cleared'])assert(result[key].every(x=>x.finite));
  const target=10**(-13.5/20);for(const key of ['compressed','afterRestore'])for(const[ch,value]of[[0,1],[1,.25],[2,target],[3,-target]])assert(Math.abs(result[key][ch].mean-value)<2e-5,`${key} channel${ch}`);
  assert(Math.abs(result.open[2].mean-1)<2e-5);assert(Math.abs(result.open[3].mean+1)<2e-5);assert(result.cleared.every(x=>x.peak===0));assert.equal(result.restored.ok,true);assert.deepEqual(result.errors.filter(x=>x.code!=='sab-unavailable'),[]);manifest.checks.browserComposition='PASS';
  const fx=await page.evaluate(()=>window.runCatalogFx());writeFileSync(join(artifacts,'browser-fx.json'),JSON.stringify(fx,null,2));assert.equal(fx.sampleRate,48000);assert(fx.active.every(x=>x.finite&&x.peak<10));
  for(const[ch,value]of[[0,.15],[1,.15],[2,.1],[3,.1/.75],[4,.05/.75],[5,.1],[6,0]])assert(Math.abs(fx.active[ch].mean-value)<2e-5,`FX DC channel${ch}`);
  assert(fx.tail.every(x=>x.finite&&x.peak<1e-4));assert.equal(fx.restored.ok,true);assert.deepEqual(fx.errors.filter(x=>x.code!=='sab-unavailable'),[]);manifest.checks.browserFx='PASS';
 }catch(error){manifest.failure=String(error);throw error;}finally{writeFileSync(join(artifacts,'manifest.json'),JSON.stringify(manifest,null,2));await browser?.close();if(server)await new Promise((yes,no)=>server.httpServer.close(error=>error?no(error):yes()));}
});
