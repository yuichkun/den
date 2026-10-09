import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const root=resolve(import.meta.dirname,'..');
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const run=(command,args,cwd)=>execFileSync(command,command==='npm'?['--cache',join(tmpdir(),'den-npm-cache'),...args]:args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:10*1024*1024});

test('three CANDIDATE sounds: packed public import, complete settings, dry render, browser reset and per-processor snapshot', {timeout:240000}, async()=>{
  const consumer=mkdtempSync(join(tmpdir(),'den-sounds-'));
  const artifacts=join(root,'artifacts/sound-candidates',new Date().toISOString().replaceAll(':','-'));mkdirSync(artifacts,{recursive:true});
  cpSync(join(root,'tests/consumer'),consumer,{recursive:true});cpSync(join(root,'tests/sound-candidates-consumer'),consumer,{recursive:true});
  writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,types:[],lib:['ES2023','DOM']},include:['bass.ts','percussion.ts','pad.ts']}));
  const files={},checks={},browserResults=[];
  const sourceFiles=['package.json','package-lock.json',...readdirSync(join(root,'src')).filter(f=>f.endsWith('.ts')).map(f=>`src/${f}`),...readdirSync(join(root,'tests')).filter(f=>f.endsWith('.spec.ts')).map(f=>`tests/${f}`),'tests/sound-candidates-packed.test.mjs',...readdirSync(join(root,'tests/sound-candidates-consumer')).map(f=>`tests/sound-candidates-consumer/${f}`)];
  const manifest={status:'CANDIDATE',runtimeStatus:'NOT_CLEARED',physicalListening:'NOT_APPROVED',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(sourceFiles.map(f=>[f,hash(join(root,f))])),den:JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,unworklet:'0.4.1',consumer:'den-clean-consumer',seed:null,input:null,fx:null,normalization:false,offlineSampleRates:[44100,48000,96000],browserSampleRates:[48000],channels:2,checks,files,limitations:['All audio remains CANDIDATE; no golden or listening approval.','Prior runtime failures remain retained by PR #26; these tests do not clear the runtime gate.','MIDI dispatch is quantum-boundary FIFO; dry stereo output is dual mono.','Headroom measurements cover the documented settings and fixed inputs, not arbitrary user edits.','Snapshots require the same processor/schema/rate; in-place cold restore requires reset and a rendered quantum.']};
  let browser,server;
  try {
    const [pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));
    assert(pack.files.some(f=>f.path==='dist/instrument-settings.d.ts'));copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));
    const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock));
    run('npm',['ci','--include=dev','--ignore-scripts'],consumer);checks.isolatedInstall='PASS';run('npm',['run','check'],consumer);checks.typecheck='PASS';
    writeFileSync(join(artifacts,'render.log'),run('node',['render.mjs'],consumer));checks.offline='PASS';
    // Preserve raw evidence before any browser failure. No previous run is overwritten.
    for(const file of ['den.tgz','package-lock.json','sound-candidates-evidence.json',...readdirSync(consumer).filter(f=>/\.(wav|svg)$/.test(f))]){copyFileSync(join(consumer,file),join(artifacts,file));files[file]=hash(join(artifacts,file));}
    const renderEvidence=JSON.parse(readFileSync(join(consumer,'sound-candidates-evidence.json'),'utf8'));
    run('npm',['run','build'],consumer);checks.build='PASS';
    manifest.wasm=Object.fromEntries(readdirSync(join(consumer,'dist/assets')).filter(f=>f.endsWith('.wasm')).map(f=>[f,{bytes:readFileSync(join(consumer,'dist/assets',f)).length,sha256:hash(join(consumer,'dist/assets',f))}]));
    assert.equal(Object.keys(manifest.wasm).length,3);
    const {preview}=await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);server=await preview({root:consumer,configFile:false,preview:{host:'127.0.0.1',port:0}});
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
    const page=await browser.newPage();await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>typeof window.runSoundCandidate==='function');
    for(const name of ['bass','percussion','pad']) {
      const result=await page.evaluate(name=>window.runSoundCandidate(name),name);browserResults.push(result);
      writeFileSync(join(artifacts,'browser.json'),JSON.stringify(browserResults,null,2));
      const expectedParameters=Object.fromEntries(Object.entries(renderEvidence.measurements.find(record=>record.name===name).parameters).map(([key,value])=>[key,Math.fround(value)]));
      assert.equal(Object.keys(expectedParameters).length,22);assert.deepEqual(result.initialParameters,expectedParameters,`${name}: initial AudioParams must equal the candidate settings`);
      assert.equal(result.sampleRate,48000);assert.deepEqual(result.errors.filter(e=>JSON.parse(e).code!=='sab-unavailable'),[]);
      for(const key of ['silent','released','reset','bypassed','clearedAfterRestore','restoredSilence','ended']){assert(result[key].finite,`${name}: ${key}`);assert.equal(result[key].peak,0,`${name}: ${key}`);}
      for(const key of ['active','restarted','inPlaceAttack','restoredAttack']){assert(result[key].finite,`${name}: ${key}`);assert(result[key].rms>0&&result[key].peak<1,`${name}: ${key}`);}
      assert.equal(result.restored.ok,true);assert.equal(result.restoredInPlace.ok,true);assert.deepEqual(result.restoredParameters,result.initialParameters);
    }
    checks.browser='PASS';files['browser.json']=hash(join(artifacts,'browser.json'));
    console.log(`CANDIDATE sound evidence: ${artifacts}`);
  } catch(error) {manifest.failure=String(error);throw error;}
  finally {
    writeFileSync(join(artifacts,'manifest.json'),JSON.stringify(manifest,null,2));
    await browser?.close();if(server)await new Promise((yes,no)=>server.httpServer.close(error=>error?no(error):yes()));
  }
});
