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

test('packed frame-sampled spectral gate controls and reset in actual 48 kHz worklets',{timeout:180000},async()=>{
 const consumer=mkdtempSync(join(tmpdir(),'den-spectral-effects-browser-')),artifacts=join(root,'artifacts/spectral-effects-browser',new Date().toISOString().replaceAll(':','-'));mkdirSync(artifacts,{recursive:true});
 const sources=['package.json','package-lock.json',...readdirSync(join(root,'src')).filter(x=>x.endsWith('.ts')).map(x=>`src/${x}`),'tests/spectral-effects-browser.test.mjs',...readdirSync(join(root,'tests/spectral-effects-browser-consumer')).map(x=>`tests/spectral-effects-browser-consumer/${x}`)];
 const manifest={status:'CANDIDATE',runtimeStatus:'NOT_CLEARED',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(sources.map(p=>[p,hash(join(root,p))])),checks:{},limitations:['Small N64 browser functional graph, not maximum-capacity or deadline clearance','Snapshot proves rendered parameter restoration; exact overlap/history/hop-phase continuation is independently proved offline','All-pass reference delay is N; full processed tails require a conservative2N drain','A spectral-bin gate is not adaptive denoising, artifact-free audio or human approval']};
 let server,browser;
 try{
  cpSync(join(root,'tests/consumer'),consumer,{recursive:true});cpSync(join(root,'tests/spectral-effects-browser-consumer'),consumer,{recursive:true});
  writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,allowImportingTsExtensions:true,types:[],lib:['ES2023','DOM']},include:['processor.ts']}));
  const[pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock));manifest.packageIntegrity=pack.integrity;
  run('npm',['ci','--include=dev','--ignore-scripts'],consumer);run('npm',['run','check'],consumer);manifest.checks.types='PASS';
  writeFileSync(join(consumer,'oracle.mjs'),`import assert from'node:assert/strict';import{renderOffline}from'@unworklet/offline';import processor from'./processor.ts';for(const sampleRate of[44100,48000,96000])for(const[threshold,floor,gain]of[[0,0,1],[100,.25,.25],[100,0,0],[100,1,1]]){const r=await renderOffline(processor,{sampleRate,duration:.1,params:{threshold:[threshold],floor:[floor]}});assert.equal(r.diagnostics.scrubbedSamples,0);for(const ch of r.outputs.main)assert(ch.every(Number.isFinite));for(let n=256;n<r.outputs.main[0].length;n++)assert(Math.abs(r.outputs.main[1][n]-gain*r.outputs.main[0][n-64])<2e-6);}console.log('Three-rate spectral control composition passed');`);
  run('node',['oracle.mjs'],consumer);manifest.checks.offline='PASS';run('npm',['run','build'],consumer);manifest.checks.build='PASS';
  manifest.wasm=Object.fromEntries(readdirSync(join(consumer,'dist/assets')).filter(x=>x.endsWith('.wasm')).map(x=>[x,hash(join(consumer,'dist/assets',x))]));
  const{preview}=await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);server=await preview({root:consumer,configFile:false,preview:{host:'127.0.0.1',port:0}});browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>typeof window.runSpectralGate==='function');const r=await page.evaluate(()=>window.runSpectralGate());writeFileSync(join(artifacts,'browser.json'),JSON.stringify(r,null,2));
  assert.equal(r.sampleRate,48000);assert.equal(r.restored.ok,true);assert.deepEqual(r.errors.filter(e=>e.code!=='sab-unavailable'),[]);
  for(const[name,gain]of[['initial',1],['attenuated',.25],['closed',0],['openFloor',1],['afterRestore',.25],['restarted',.25]]){const a=r[name];assert(a.every(x=>x.finite));near(a[0].amplitude,.125,`${name} source frequency`);near(a[1].re,gain*a[0].re,`${name} N64 phase/gain real`);near(a[1].im,gain*a[0].im,`${name} N64 phase/gain imaginary`);near(a[1].amplitude,gain*.125,`${name} gate amplitude`);}
  assert.equal(r.closed[1].peak,0);for(const a of r.reset)assert.equal(a.peak,0);
  manifest.checks.browser='PASS';
 }catch(error){manifest.failure=String(error);throw error;}finally{writeFileSync(join(artifacts,'manifest.json'),JSON.stringify(manifest,null,2));await browser?.close();if(server)await new Promise((yes,no)=>server.httpServer.close(e=>e?no(e):yes()));}
});
