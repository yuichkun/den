import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, copyFileSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command,args,cwd) => execFileSync(command,command === 'npm' ? ['--cache',join(tmpdir(),'den-npm-cache'),...args] : args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,npm_config_cache:process.env.npm_config_cache??join(tmpdir(),'den-npm-cache')}});

test('packed package → isolated TypeScript consumer → production build → real AudioParams and snapshots', {timeout:180000}, async () => {
  const consumer = mkdtempSync(join(tmpdir(),'den-consumer-'));
  cpSync(join(root,'tests/consumer'),consumer,{recursive:true});
  const pack = JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));
  copyFileSync(join(consumer,pack[0].filename),join(consumer,'den.tgz'));
  assert(pack[0].files.some(f=>f.path==='dist/index.d.ts'));
  assert(!pack[0].files.some(f=>/^(src|tests|node_modules)\//.test(f.path)));
  // Only the local candidate tarball changes; all registry dependencies stay locked.
  const lock = JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack[0].integrity;
  writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock,null,2)+'\n');
  run('npm',['ci','--ignore-scripts'],consumer);
  run('npm',['run','check'],consumer);
  run('npm',['run','build'],consumer);
  console.log(run('node',['render.mjs'],consumer).trim());
  const {preview} = await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);
  const server = await preview({root:consumer,configFile:false,preview:{host:'127.0.0.1',port:0}});
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
    const page = await browser.newPage();
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(()=>typeof window.runGate==='function');
    const result = await page.evaluate(()=>window.runGate());
    for(const [name,expected] of [['before',0.5],['changed',0.25],['after',0.5]]) {
      assert.equal(result[name].length,256);
      assert(result[name].every(x=>Math.abs(x-expected)<1e-6),`${name}: ${result[name].slice(0,8)}`);
    }
    assert.equal(result.restored.ok,true);
    // #78 reproduction: suspended snapshot records the last rendered AudioParam.
    assert.equal(result.initial.slots.gain.value,0);
    assert.equal(result.suspended.slots.gain.value,0.5);
    assert.equal(result.saved.slots.gain.value,0.5);
    const artifacts=join(root,'artifacts'); mkdirSync(artifacts,{recursive:true});
    const files={};
    for(const file of readdirSync(consumer).filter(f=>/^candidate-|^snapshot-|^package-lock.json$|^den.tgz$/.test(f))) {
      copyFileSync(join(consumer,file),join(artifacts,file)); files[file]=hash(readFileSync(join(consumer,file)));
    }
    writeFileSync(join(artifacts,'browser.json'),JSON.stringify(result,null,2));
    files['browser.json']=hash(readFileSync(join(artifacts,'browser.json')));
    copyFileSync(join(root,'package-lock.json'),join(artifacts,'den-package-lock.json'));
    files['den-package-lock.json']=hash(readFileSync(join(root,'package-lock.json')));
    writeFileSync(join(artifacts,'manifest.json'),JSON.stringify({status:'CANDIDATE',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(['src/index.ts','src/gate.ts','package-lock.json','tests/consumer/render.mjs','tests/consumer/main.js','tests/consumer/contract.ts','tests/entry.test.mjs'].map(f=>[f,hash(readFileSync(join(root,f)))])),den:'0.0.0',unworklet:'0.4.1',consumer:'den-clean-consumer (locked fixture)',settings:{scale:1,initialPrevious:0},node:process.version,sampleRates:[44100,48000,96000],channels:1,samples:256,parameters:{gain:0.5},input:'sample[i]=(i+1)/256 for i=0..255',midi:[],seed:null,engine:'den.entry.gate.v1',preset:null,files,verification:'sample-exact one-sample delay × gain; clean restore; browser gain 0.5→0.25→0.5',limitations:['Not human approved','same-schema snapshots only','snapshot after rendered AudioParam changes only']},null,2));
  } finally {
    await browser?.close();
    await new Promise((resolve,reject)=>server.httpServer.close(e=>e?reject(e):resolve()));
  }
});
