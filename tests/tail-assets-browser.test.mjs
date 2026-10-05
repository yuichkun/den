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

test('packed prepared convolution and crossfaded resident-loop ingress/state in actual 48 kHz worklets',{timeout:180000},async()=>{
 const consumer=mkdtempSync(join(tmpdir(),'den-tail-assets-browser-')),artifacts=join(root,'artifacts/tail-assets-browser',new Date().toISOString().replaceAll(':','-'));mkdirSync(artifacts,{recursive:true});
 const sources=['package.json','package-lock.json',...readdirSync(join(root,'src')).filter(x=>x.endsWith('.ts')).map(x=>`src/${x}`),'tests/tail-assets-browser.test.mjs',...readdirSync(join(root,'tests/tail-assets-browser-consumer')).map(x=>`tests/tail-assets-browser-consumer/${x}`)];
 const manifest={status:'CANDIDATE',runtimeStatus:'NOT_CLEARED',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(sources.map(p=>[p,hash(join(root,p))])),checks:{},limitations:['Prepared-packet precondition and normalized input remain mandatory','B128/P64 execution and browser success do not establish realtime deadline clearance','Loop period is L-F and its linear overlap may cancel or smear content','Browser steady-state/status/asset restore supplements independent all-sample latency and continuation proofs']};
 let server,browser;
 try{
  cpSync(join(root,'tests/consumer'),consumer,{recursive:true});cpSync(join(root,'tests/tail-assets-browser-consumer'),consumer,{recursive:true});
  writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,allowImportingTsExtensions:true,types:[],lib:['ES2023','DOM']},include:['convolution-processor.ts','loop-processor.ts']}));
  const[pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock));manifest.packageIntegrity=pack.integrity;
  run('npm',['ci','--include=dev','--ignore-scripts'],consumer);run('npm',['run','check'],consumer);manifest.checks.types='PASS';
  writeFileSync(join(consumer,'oracle.mjs'),`import assert from'node:assert/strict';import{renderOffline}from'@unworklet/offline';import{prepareConvolutionSpectrum}from'@denaudio/den/prepared-convolution';import convolution from'./convolution-processor.ts';import loop from'./loop-processor.ts';for(const sampleRate of[44100,48000,96000]){const packet=prepareConvolutionSpectrum([.5],{blockSize:128,partitions:64});const c=await renderOffline(convolution,{sampleRate,duration:.04,messages:[{name:'ir',payload:packet,atQuantum:0}]});assert.equal(c.diagnostics.scrubbedSamples,0);for(let n=256;n<c.outputs.main[0].length;n++)assert(Math.abs(c.outputs.main[1][n]-.5*c.outputs.main[0][n-128])<2e-6);const l=await renderOffline(loop,{sampleRate,duration:.02,params:{gate:[1]},messages:[{name:'load',payload:{data:new Float32Array(8).fill(.25)},atQuantum:0}]});assert.equal(l.diagnostics.scrubbedSamples,0);assert(l.outputs.main[0].some(v=>v===.25));assert(l.outputs.main[0].every(v=>v===0||v===.25));}console.log('Three-rate bounded native tail-asset composition passed');`);
  run('node',['oracle.mjs'],consumer);manifest.checks.offline='PASS';run('npm',['run','build'],consumer);manifest.checks.build='PASS';
  manifest.wasm=Object.fromEntries(readdirSync(join(consumer,'dist/assets')).filter(x=>x.endsWith('.wasm')).map(x=>[x,hash(join(consumer,'dist/assets',x))]));
  const{preview}=await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);server=await preview({root:consumer,configFile:false,preview:{host:'127.0.0.1',port:0}});browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>typeof window.runTailAssets==='function');const r=await page.evaluate(()=>window.runTailAssets());writeFileSync(join(artifacts,'browser.json'),JSON.stringify(r,null,2));
  assert.equal(r.sampleRate,48000);assert.deepEqual(r.errors.filter(e=>e.code!=='sab-unavailable'),[]);
  const c=r.convolution;assert.equal(c.restored.ok,true);
  const multiply=(a,b)=>({re:a.re*b.re-a.im*b.im,im:a.re*b.im+a.im*b.re});
  for(const name of['full','afterRestore','restarted','short']){const a=c[name];assert(a.every(x=>x.finite));assert.equal(a[2].mean,1);assert.equal(a[3].peak,0);near(a[0].amplitude,.125,`${name} source`);
   // At bin3, B128 contributes minus one; last IR tap8191 contributes exp(+i*omega).
   const h=name==='short'?{re:.25,im:0}:{re:-.5-.25*Math.cos(6*Math.PI/256),im:-.25*Math.sin(6*Math.PI/256)};const expected=multiply(a[0],h);near(a[1].re,expected.re,`${name} prepared FIR real`);near(a[1].im,expected.im,`${name} prepared FIR phase`);}
  for(const name of['absent','rejected','unloaded']){assert(c[name].every(x=>x.finite));assert.equal(c[name][1].peak,0);assert.equal(c[name][2].peak,0);assert.equal(c[name][3].mean,+(name==='rejected'));}
  assert.equal(c.reset[0].peak,0);assert.equal(c.reset[1].peak,0);assert.equal(c.reset[2].mean,1);assert.equal(c.reset[3].peak,0);
  const l=r.loop;assert.equal(l.restored.ok,true);const original=Float32Array.from([.1,.2,.3,.4,.5,.6,.7,.8]),short=original.slice(0,3);
  const scalar=(pcm,q)=>{const length=pcm.length,fade=Math.min(2,Math.floor(length/2)),period=length-fade;const at=x=>{const i=Math.min(length-1,Math.floor(x)),j=Math.min(length-1,i+1),f=x-Math.floor(x);return pcm[i]*(1-f)+pcm[j]*f;};const primary=fade+q;if(q<period-fade)return at(primary);const local=q-(period-fade),w=local/fade;return(1-w)*at(primary)+w*at(local);};
  for(const[name,pcm,step]of[['forward',original,1],['reverse',original,-1],['fractional',original,.5],['short',short,.5],['afterRestore',original,.5],['restarted',original,.5]]){const a=l[name],period=pcm.length-Math.min(2,Math.floor(pcm.length/2));assert(a.every(x=>x.finite));assert.equal(a[2].mean,period);assert.equal(a[3].mean,pcm.length-period);assert.equal(a[4].mean,1);assert.equal(a[5].peak,0);
   for(let n=0;n<256;n++){near(a[0].samples[n],scalar(pcm,a[1].samples[n]),`${name} sample${n}`,2e-6);if(n)near(a[1].samples[n],((a[1].samples[n-1]+step)%period+period)%period,`${name} phase${n}`,1e-6);}}
  for(const name of['absent','loaded','replacedHeld','released','reset','unloaded']){assert(l[name].every(x=>x.finite));assert.equal(l[name][0].peak,0);assert.equal(l[name][4].peak,0);}
  assert.equal(l.absent[5].mean,1);assert.equal(l.unloaded[5].mean,1);assert.equal(l.replacedHeld[2].mean,2);assert.equal(l.replacedHeld[5].peak,0);
  manifest.checks.browser='PASS';
 }catch(error){manifest.failure=String(error);throw error;}finally{writeFileSync(join(artifacts,'manifest.json'),JSON.stringify(manifest,null,2));await browser?.close();if(server)await new Promise((yes,no)=>server.httpServer.close(e=>e?no(e):yes()));}
});
