import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { buildConsumer } from '../scripts/build-consumer.mjs';

const root = resolve(import.meta.dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command,args,cwd) => execFileSync(command,command === 'npm' ? ['--cache',join(tmpdir(),'den-npm-cache'),...args] : args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,npm_config_cache:process.env.npm_config_cache??join(tmpdir(),'den-npm-cache')}});

test('packed package → isolated TypeScript consumer → production build → real AudioParams and snapshots', {timeout:180000}, async () => {
  const {consumer, pack, output} = buildConsumer();
  assert(pack.files.some(f=>f.path==='dist/index.d.ts'));
  assert(!pack.files.some(f=>/^(src|tests|node_modules)\//.test(f.path)));
  const installed = join(consumer,'node_modules/@denaudio/den');
  const readme = readFileSync(join(installed,'README.md'),'utf8');
  for (const match of readme.matchAll(/\]\(([^)]+)\)/g)) {
    if (!/^[a-z]+:/i.test(match[1]) && !match[1].startsWith('#')) {
      assert(existsSync(join(installed,match[1].split('#')[0])), `Broken package link: ${match[1]}`);
    }
  }
  for (const doc of ['contracts.md','dependency-findings.md','deployment-status.md']) {
    assert(pack.files.some(f=>f.path===`docs/${doc}`));
  }
  console.log(run('node',['render.mjs'],consumer).trim());
  const {preview} = await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);
  const server = await preview({root:consumer,configFile:false,build:{outDir:output},preview:{host:'127.0.0.1',port:0}});
  let browser;
  try {
    browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
    const page = await browser.newPage();
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(()=>typeof window.runGate==='function');
    const browserRates = [];
    for (const sampleRate of [44100,48000,96000]) {
      const result = await page.evaluate(rate=>window.runGate(rate),sampleRate);
      assert.equal(result.actualSampleRate,sampleRate);
      browserRates.push(result);
      if (sampleRate !== 48000) {
        assert.equal(result.status,'blocked');
        assert.match(result.error,new RegExp(`compiled for 48000 Hz.*AudioContext runs at ${sampleRate} Hz`));
      } else {
        assert.equal(result.status,'rendered');
      }
    }
    const result = browserRates.find(r=>r.actualSampleRate===48000);
    for(const [name,expected] of [['before',0.5],['changed',0.25],['after',0.5]]) {
      assert.equal(result[name].length,256);
      assert(result[name].every(x=>Math.abs(x-expected)<1e-6),`${name}: ${result[name].slice(0,8)}`);
    }
    assert.equal(result.restored.ok,true);
    // #78 reproduction: suspended snapshot records the last rendered AudioParam.
    assert.equal(result.initial.slots.gain.value,0);
    assert.equal(result.suspended.slots.gain.value,0.5);
    assert.equal(result.saved.slots.gain.value,0.5);
    await page.getByRole('button',{name:'Run silent check'}).click();
    await page.waitForFunction(()=>document.querySelector('#result').textContent.startsWith('Passed at 48000 Hz.'));
    const artifacts=join(root,'artifacts'); mkdirSync(artifacts,{recursive:true});
    const files={};
    for(const file of readdirSync(consumer).filter(f=>/^candidate-|^snapshot-|^package-lock.json$|^den.tgz$/.test(f))) {
      copyFileSync(join(consumer,file),join(artifacts,file)); files[file]=hash(readFileSync(join(consumer,file)));
    }
    writeFileSync(join(artifacts,'browser.json'),JSON.stringify(browserRates,null,2));
    files['browser.json']=hash(readFileSync(join(artifacts,'browser.json')));
    copyFileSync(join(root,'package-lock.json'),join(artifacts,'den-package-lock.json'));
    files['den-package-lock.json']=hash(readFileSync(join(root,'package-lock.json')));
    writeFileSync(join(artifacts,'manifest.json'),JSON.stringify({status:'CANDIDATE',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(['src/index.ts','src/gate.ts','package-lock.json','tests/consumer/render.mjs','tests/consumer/main.js','tests/consumer/contract.ts','tests/entry.test.mjs','scripts/build-consumer.mjs','vercel.json','tests/consumer/index.html'].map(f=>[f,hash(readFileSync(join(root,f)))])),den:'0.0.0',unworklet:'0.4.1',consumer:'den-clean-consumer (locked fixture)',settings:{scale:1,initialPrevious:0},node:process.version,offlineSampleRates:[44100,48000,96000],browserCoverage:browserRates.map(({actualSampleRate,status,error})=>({sampleRate:actualSampleRate,status,error})),browserRenderedSampleRates:[48000],channels:1,samples:256,parameters:{gain:0.5},input:'sample[i]=(i+1)/256 for i=0..255',midi:[],seed:null,engine:'den.entry.gate.v1',preset:null,files,verification:'sample-exact one-sample delay × gain; clean restore; browser gain 0.5→0.25→0.5',limitations:['Browser 44100/96000 blocked by unworklet 0.4.1 baked-rate guard; no runtime rate option in unplugin','Not human approved','same-schema snapshots only','snapshot after rendered AudioParam changes only']},null,2));
  } finally {
    await browser?.close();
    await new Promise((resolve,reject)=>server.httpServer.close(e=>e?reject(e):resolve()));
  }
});
