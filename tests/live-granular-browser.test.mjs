import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const root=resolve(import.meta.dirname,'..'),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const run=(cmd,args,cwd)=>execFileSync(cmd,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
test('packed live granular: native window/flags, latched controls, joint restore and source expiry', {timeout:180000}, async()=>{
  const sourceCommit=run('git',['rev-parse','HEAD'],root).trim(),consumer=mkdtempSync(join(tmpdir(),'den-live-granular-browser-'));
  const artifact=join(root,'artifacts/live-granular-browser',new Date().toISOString().replaceAll(':','-'));mkdirSync(artifact,{recursive:true});
  const sourcePaths=['src/live-granular.ts','src/live-buffer.ts','package.json','package-lock.json','tests/live-granular-browser.test.mjs',...readdirSync(join(root,'tests/live-granular-browser-consumer')).map(n=>`tests/live-granular-browser-consumer/${n}`)];
  const manifest={status:'CANDIDATE',runtimeStatus:'NOT_CLEARED',sourceCommit,sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(sourcePaths.map(p=>[p,hash(join(root,p))])),consumer,checks:{},files:{}};
  let browser,server;
  try{
    for(const name of['package.json','package-lock.json'])copyFileSync(join(root,'tests/consumer',name),join(consumer,name));
    cpSync(join(root,'tests/live-granular-browser-consumer'),consumer,{recursive:true});
    writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,types:[],lib:['ES2023','DOM']},include:['processor.ts']}));
    const[pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));for(const name of['live-buffer','live-granular'])assert(pack.files.some(f=>f.path===`dist/${name}.d.ts`));
    copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));manifest.packageIntegrity=pack.integrity;
    const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json')));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock));
    run('npm',['ci','--include=dev','--ignore-scripts'],consumer);manifest.checks.install='PASS';
    run('npm',['run','check'],consumer);manifest.checks.types='PASS';console.log(run('node',['oracle.mjs'],consumer));manifest.checks.offline='PASS';
    run('npm',['run','build'],consumer);manifest.checks.build='PASS';
    const{preview}=await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);server=await preview({root:consumer,configFile:false,preview:{host:'127.0.0.1',port:0}});
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
    const page=await browser.newPage();await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>typeof window.runLiveGranular==='function');
    const r=await page.evaluate(()=>window.runLiveGranular());writeFileSync(join(artifact,'browser.json'),JSON.stringify(r,null,2));
    assert.equal(r.sampleRate,48000);assert.deepEqual(r.errors.filter(e=>e.code!=='sab-unavailable'),[]);
    const check=(name,expected)=>{assert(r[name].every(x=>x.finite),name);for(const[ch,value]of Object.entries(expected)){const x=r[name][+ch];assert.equal(x.mean,value,`${name} channel ${ch} mean`);assert.equal(x.minimum,value,`${name} channel ${ch} minimum`);assert.equal(x.maximum,value,`${name} channel ${ch} maximum`);}};
    const window=(name,value)=>{
      check(name,{1:1,2:1,3:2,4:0,5:0,7:value,8:1,9:32,10:32});
      const audio=r[name][0].samples,elapsed=r[name][6].samples,N=2*r.sampleRate;assert.equal(audio.length,2048);assert.equal(elapsed.length,2048);
      assert(elapsed[0]>0&&elapsed.at(-1)<N-1,`${name}: observed interior of the two-second grain`);
      let residual=0;for(let n=0;n<audio.length;n++){assert(Number.isInteger(elapsed[n]));if(n)assert.equal(elapsed[n],elapsed[n-1]+1);const expected=value*Math.max(0,1-Math.abs(2*elapsed[n]/(N-1)-1));residual=Math.max(residual,Math.abs(audio[n]-expected));}assert(residual<2e-6,`${name} triangle/sample residual ${residual}`);return residual;
    };
    for(const name of['initial','cleared','negativePrepared','heldReset','emptyPrepared'])check(name,{0:0,1:0,2:0,3:0,4:0,5:0,7:0,8:0,9:0,10:0});
    for(const name of['filled','paused'])check(name,{0:0,1:0,2:0,3:0,4:0,5:0,7:.671875,8:1,9:32,10:32});
    for(const name of['negativeFilled','negativePaused'])check(name,{0:0,1:0,2:0,3:0,4:0,5:0,7:-.328125,8:1,9:32,10:32});
    const residuals={};for(const name of['active','latchedEdits','beforeSave','afterRestore','expiryPrepared'])residuals[name]=window(name,.671875);
    for(const name of['negativeActive','controlsPrepared'])residuals[name]=window(name,-.328125);
    check('latchedEdits',{11:0,12:0,13:0,14:0,15:1,16:0,17:32,18:.25,19:3});
    const savedControls={11:0,12:0,13:0,14:4,15:0,16:2,17:32,18:.25,19:3};for(const name of['beforeSave','controlsPrepared','afterRestore'])check(name,savedControls);
    assert.equal(r.restored.ok,true);assert(r.afterRestore[6].mean>r.beforeSave[6].mean,'restored noninitial phase continues while rendering');
    check('expiryPrepared',{11:0,12:0,13:0,14:4,15:0,16:2,17:128,18:.25,19:3});
    for(const name of['expired','expiredPaused'])check(name,{0:0,1:0,2:1,3:2,4:0,5:1,7:2.171875,8:1,9:64,10:128});
    check('emptyRejected',{0:0,1:0,2:0,3:0,4:3,5:0,7:0,8:0,9:0,10:0});
    manifest.browserResiduals=residuals;manifest.checks.browser='PASS';
  }catch(error){manifest.failure=String(error);throw error;}
  finally{
    for(const file of['den.tgz','package-lock.json','native-composition.json']){try{copyFileSync(join(consumer,file),join(artifact,file));manifest.files[file]=hash(join(artifact,file));}catch{}}
    try{cpSync(join(consumer,'dist'),join(artifact,'dist'),{recursive:true});}catch{}try{manifest.files['browser.json']=hash(join(artifact,'browser.json'));}catch{}
    writeFileSync(join(artifact,'manifest.json'),JSON.stringify(manifest,null,2));await browser?.close();if(server)await new Promise((resolve,reject)=>server.httpServer.close(e=>e?reject(e):resolve()));
    // Only this test's newly created dependency installation is disposable.
    // Package, lock, fixtures, built outputs and evidence remain retained.
    rmSync(join(consumer,'node_modules'),{recursive:true,force:true});
  }
});
