import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '..');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
test('packed live buffer: actual native wrap, pause, read ordering and guarded history restore', { timeout: 180000 }, async () => {
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], root).trim();
  const artifact = join(root, 'artifacts/live-buffer-browser', new Date().toISOString().replaceAll(':','-')); mkdirSync(artifact, { recursive: true });
  const consumer = mkdtempSync(join(tmpdir(), 'den-live-buffer-browser-'));
  const sourcePaths = ['src/live-buffer.ts','package.json','package-lock.json','tests/live-buffer-browser.test.mjs', ...readdirSync(join(root,'tests/live-buffer-browser-consumer')).map(n => `tests/live-buffer-browser-consumer/${n}`)];
  const manifest = { status:'CANDIDATE', runtimeStatus:'NOT_CLEARED', sourceCommit, sourceDirty:run('git',['status','--porcelain'],root).trim() !== '', sourceHashes:Object.fromEntries(sourcePaths.map(p => [p,hash(join(root,p))])), consumer, checks:{}, files:{} };
  let browser, server;
  try {
    for (const name of ['package.json','package-lock.json']) copyFileSync(join(root,'tests/consumer',name),join(consumer,name));
    cpSync(join(root,'tests/live-buffer-browser-consumer'),consumer,{recursive:true});
    writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,types:[],lib:['ES2023','DOM']},include:['processor.ts']}));
    const [pack] = JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));
    assert(pack.files.some(f => f.path === 'dist/live-buffer.d.ts')); copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz')); manifest.packageIntegrity=pack.integrity;
    const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'))); lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity; writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock));
    run('npm',['ci','--include=dev','--ignore-scripts'],consumer); manifest.checks.install='PASS';
    run('npm',['run','check'],consumer); manifest.checks.types='PASS';
    console.log(run('node',['oracle.mjs'],consumer)); manifest.checks.offline='PASS';
    run('npm',['run','build'],consumer); manifest.checks.build='PASS';
    const {preview}=await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);server=await preview({root:consumer,configFile:false,preview:{host:'127.0.0.1',port:0}});
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
    const page=await browser.newPage();await page.goto(server.resolvedUrls.local[0]);await page.waitForFunction(()=>typeof window.runLiveBuffer==='function');
    const r=await page.evaluate(()=>window.runLiveBuffer());writeFileSync(join(artifact,'browser.json'),JSON.stringify(r,null,2));
    assert.equal(r.sampleRate,48000);assert.deepEqual(r.errors.filter(e=>e.code!=='sab-unavailable'),[]);
    const check=(name,expected)=>{assert(r[name].every(x=>x.finite),name);for(const[channel,value]of Object.entries(expected)){const x=r[name][+channel];assert.equal(x.mean,value,`${name} channel${channel} mean`);assert.equal(x.minimum,value,`${name} channel${channel} minimum`);assert.equal(x.maximum,value,`${name} channel${channel} maximum`);}};
    check('initial',{0:0,1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0,15:0,16:0,17:0});
    check('partial',{0:.375,1:.375,2:1,3:3,4:0,5:0,6:3,7:3,8:.375,9:0,15:.5625,16:.9375,17:1});
    check('fractional',{0:.34375,1:.34375,2:1,3:3,5:0,6:3,7:3});
    check('expired',{0:0,1:0,2:0,3:3,5:0,6:3,7:3,17:0});
    check('writePrepared',{0:.375,1:.375,2:1,3:3,4:0,5:0,6:3,7:3,10:0,11:0,12:0,13:20,14:.25,15:.5625,16:.9375});
    check('wrapped',{0:1.4375,1:1.4375,2:1,3:8,4:1,5:0,6:20,7:20,8:1.4375,9:1,15:15.4375,16:16.875});
    check('beforeSave',{0:1.40625,1:1.40625,2:1,3:8,4:1,6:20,7:20,15:15.4375,16:16.875});
    for(const name of ['heldClear','heldReset'])check(name,{0:0,1:0,2:0,3:0,4:0,5:0,6:0,8:0,9:0,15:0,16:0,17:0});
    for(const name of ['mutated','pausedMutation','controlsPrepared'])check(name,{0:-.34375,1:-.34375,2:1,3:4,4:0,5:0,6:4,8:-.3125,9:0,15:-.875,16:-1.21875});
    const controls={10:0,11:0,12:.5,13:20,14:.25};check('controlsPrepared',controls);check('beforeSave',controls);check('afterRestore',controls);
    assert.equal(r.restored.ok,true);assert.deepEqual(r.afterRestore,r.beforeSave,'native full history/cursor/checksums restored while controls remain stable');
    assert.equal(r.restoredAges.length,8);
    for(let age=0;age<8;age++){const stage=r.restoredAges[age];assert(stage.every(x=>x.finite));for(const channel of[0,1]){const expected=1.4375-age/16;assert.equal(stage[channel].minimum,expected);assert.equal(stage[channel].maximum,expected);}assert.equal(stage[2].mean,1);assert.equal(stage[3].mean,8);assert.equal(stage[6].mean,20);assert.equal(stage[7].mean,20);}
    check('continuePrepared',{0:1.4375,1:1.4375,2:1,3:8,4:1,5:0,6:20,7:20,10:0,11:0,12:0,13:21,14:.25,15:15.4375,16:16.875});
    check('continued',{0:1.5,1:1.5,2:1,3:8,4:1,5:0,6:21,7:21,8:1.5,9:1.0625,15:16.875,16:18.375});
    check('resetReleased',{0:.3125,1:.3125,2:1,3:2,4:0,5:0,6:2,8:.3125,9:0,15:.25,16:.5625});
    manifest.checks.browser='PASS';
  } catch(error) {manifest.failure=String(error);throw error;}
  finally {
    for(const file of ['den.tgz','package-lock.json','native-composition.json']){try{copyFileSync(join(consumer,file),join(artifact,file));manifest.files[file]=hash(join(artifact,file));}catch{}}
    try{cpSync(join(consumer,'dist'),join(artifact,'dist'),{recursive:true});}catch{}
    try{manifest.files['browser.json']=hash(join(artifact,'browser.json'));}catch{}
    writeFileSync(join(artifact,'manifest.json'),JSON.stringify(manifest,null,2));await browser?.close();if(server)await new Promise((resolve,reject)=>server.httpServer.close(e=>e?reject(e):resolve()));
    // Only this test's new disposable dependency installation is removed.
    // Tarball, lock, fixtures, built output and all evidence remain retained.
    rmSync(join(consumer,'node_modules'),{recursive:true,force:true});
  }
});
