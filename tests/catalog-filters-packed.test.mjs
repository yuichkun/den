import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const root=join(import.meta.dirname,'..'),hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const run=(command,args,cwd)=>execFileSync(command,command==='npm'?['--cache',join(tmpdir(),'den-npm-cache'),...args]:args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024});
test('public catalog filters: isolated pack/types/render/build and actual 48 kHz worklet', {timeout:240000},async()=>{
 const consumer=mkdtempSync(join(tmpdir(),'den-catalog-filters-')),artifacts=join(root,'artifacts/catalog-filters',new Date().toISOString().replaceAll(':','-'));mkdirSync(artifacts,{recursive:true});
 cpSync(join(root,'tests/consumer'),consumer,{recursive:true});cpSync(join(root,'tests/catalog-filters-consumer'),consumer,{recursive:true});
 writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,types:[],lib:['ES2023','DOM']},include:['processor.ts']}));
 const sources=['package.json','package-lock.json',...['catalog-filter-math','state-variable-filter','biquad-eq','crossover','formant-bank'].map(name=>`src/${name}.ts`),'tests/catalog-filters.spec.ts','tests/fixtures/eq-before-tpt.ts','tests/catalog-filters-packed.test.mjs',...readdirSync(join(root,'tests/catalog-filters-consumer')).map(name=>`tests/catalog-filters-consumer/${name}`)];
 const manifest={status:'CANDIDATE',runtimeStatus:'NOT_CLEARED',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(sources.map(path=>[path,hash(join(root,path))])),dependencies:{unworklet:'0.4.1'},checks:{},files:{}};let browser,server;
 try{
  const [pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));manifest.packageIntegrity=pack.integrity;
  const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock));
  run('npm',['ci','--include=dev','--ignore-scripts'],consumer);manifest.checks.install='PASS';run('npm',['run','check'],consumer);manifest.checks.typecheck='PASS';
  run('node',['render.mjs'],consumer);manifest.checks.offline='PASS';
  for(const path of ['den.tgz','package-lock.json','catalog-filters-evidence.json',...readdirSync(consumer).filter(path=>/\.(wav|svg|f32)$/.test(path))]){copyFileSync(join(consumer,path),join(artifacts,path));manifest.files[path]=hash(join(artifacts,path));}
  run('npm',['run','build'],consumer);manifest.checks.build='PASS';manifest.wasm=Object.fromEntries(readdirSync(join(consumer,'dist/assets')).filter(path=>path.endsWith('.wasm')).map(path=>[path,hash(join(consumer,'dist/assets',path))]));
  const {preview}=await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);server=await preview({root:consumer,configFile:false,preview:{host:'127.0.0.1',port:0}});
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>typeof window.runCatalogFilters==='function');
  const result=await page.evaluate(()=>window.runCatalogFilters());writeFileSync(join(artifacts,'browser.json'),JSON.stringify(result,null,2));manifest.files['browser.json']=hash(join(artifacts,'browser.json'));
  assert.equal(result.sampleRate,48000);assert(result.active.every(x=>x.finite));for(const ch of [0,1,2])assert(Math.abs(result.active[ch].mean-.25)<1e-5);for(const ch of [3,4])assert(result.active[ch].peak<1e-5);
  assert(result.cleared.every(x=>x.finite&&x.peak===0));assert.equal(result.restored.ok,true);assert.deepEqual(result.errors.filter(e=>e.code!=='sab-unavailable'),[]);manifest.checks.browser='PASS';
 }catch(error){manifest.failure=String(error);throw error;}finally{writeFileSync(join(artifacts,'manifest.json'),JSON.stringify(manifest,null,2));await browser?.close();if(server)await new Promise((resolve,reject)=>server.httpServer.close(error=>error?reject(error):resolve()));}
});
