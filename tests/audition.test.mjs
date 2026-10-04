import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { buildConsumer } from '../scripts/build-consumer.mjs';

test('packed mobile audition: gesture playback, controls, release, repeated stop and startup cancellation', {timeout:180000}, async()=>{
  const {consumer,output}=buildConsumer({stageSite:false});
  console.log(execFileSync('node',['audition-render.mjs'],{cwd:consumer,encoding:'utf8'}).trim());
  const {preview}=await import(pathToFileURL(join(consumer,'node_modules/vite/dist/node/index.js')).href);
  let server, browser;
  try {
    server=await preview({root:consumer,configFile:false,build:{outDir:output},preview:{host:'127.0.0.1',port:0}});
    // Deliberately no autoplay bypass: Start and touch must unlock audio themselves.
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});
    const page=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    // Observe actual native output nodes and context closure independently of UI status.
    await page.addInitScript(()=>{
      window.__contexts=[];const Original=window.AudioContext;
      window.AudioContext=class extends Original {constructor(...args){if(window.__failContext)throw new DOMException('48 kHz unavailable','NotSupportedError');super(...args);window.__contexts.push(this);}};
      window.__analysers=[];const Analyser=window.AnalyserNode;
      window.AnalyserNode=class extends Analyser {constructor(...args){super(...args);window.__analysers.push(this);}};
    });
    const state=()=>page.evaluate(()=>window.denAudition.state());
    const peak=()=>page.evaluate(()=>{const a=window.__analysers.at(-1),v=new Float32Array(a.fftSize);a.getFloatTimeDomainData(v);return Math.max(...v.map(Math.abs));});
    const set=async(id,value)=>page.locator('#'+id).evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));},value);
    const advance=async(seconds)=>{
      const until=await page.evaluate(seconds=>window.__contexts.at(-1).currentTime+seconds,seconds);
      await page.waitForFunction(until=>window.__contexts.at(-1).currentTime>=until,until);
    };
    await page.goto(server.resolvedUrls.local[0]+'audition.html');
    await page.waitForFunction(()=>window.denAudition);
    assert.equal(await page.evaluate(()=>window.__contexts.length),0,'no context or autoplay on load');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile layout overflows');
    await page.evaluate(()=>{window.__failContext=true;});
    await page.getByRole('button',{name:'Start tone',exact:true}).tap();
    assert.match(await page.locator('#status').textContent(),/Audio unavailable: 48 kHz unavailable/);
    assert.equal((await state()).contextState,'closed');
    assert.equal(await page.evaluate(()=>window.__contexts.length),0);
    await page.evaluate(()=>{window.__failContext=false;});
    await page.getByRole('button',{name:'Start tone',exact:true}).tap();
    await page.waitForFunction(()=>window.denAudition.state().peak>0.015);
    assert.equal((await state()).sampleRate,48000);
    assert((await peak())<=0.036,'default output exceeds 3.5%');
    const artifacts=join(import.meta.dirname,'../artifacts/audition');mkdirSync(artifacts,{recursive:true});
    await page.screenshot({path:join(artifacts,'mobile-playing.png'),fullPage:true});
    await set('volume',0.1);await set('sustain',1);await set('depth',2);await set('rate',12);
    await advance(0.25);
    assert((await peak())>0.08);assert((await peak())<=0.10001,'output cap exceeded');
    await set('volume',0);await advance(0.35);assert((await peak())<1e-6,'zero volume is not silent');
    await set('volume',0.035);await set('release-time',0.1);
    // Let the smoothed release control settle before the envelope latches it.
    await advance(0.2);
    await page.getByRole('button',{name:'Release',exact:true}).tap();
    await advance(0.25);assert((await peak())<1e-6,'release did not reach silence');
    await page.getByRole('button',{name:'Stop audio',exact:true}).tap();
    await page.waitForFunction(()=>window.denAudition.state().contextState==='closed');
    for(let n=0;n<3;n++){
      await page.getByRole('button',{name:'Start tone',exact:true}).tap();
      await page.waitForFunction(()=>window.denAudition.state().peak>0.01);
      await page.getByRole('button',{name:'Stop audio',exact:true}).tap();
      await page.waitForFunction(()=>window.denAudition.state().contextState==='closed');
    }
    assert.equal(await page.evaluate(()=>window.__contexts.every(c=>c.state==='closed')),true,'Stop leaked contexts');
    // Real touch events, including finger release outside the pad through pointer capture.
    const client=await context.newCDPSession(page);
    await page.locator('#pad').scrollIntoViewIfNeeded();const box=await page.locator('#pad').boundingBox();
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+80,y:box.y+40}]});
    await page.waitForFunction(()=>window.denAudition.state().peak>0.01);
    await client.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
    await advance(0.25);assert((await peak())<1e-6,'touch release stuck a note');
    await page.getByRole('button',{name:'Stop audio',exact:true}).tap();
    await page.waitForFunction(()=>window.denAudition.state().contextState==='closed');
    // A release and renewed hold while the first worklet is loading must retain
    // the latest held intent. Hold the real worklet WASM request behind a barrier.
    let unblock,began; const barrier=new Promise(resolve=>{unblock=resolve;});
    const begun=new Promise(resolve=>{began=resolve;});
    await page.route('**/*.wasm',async route=>{began();await barrier;await route.continue();});
    await page.locator('#pad').scrollIntoViewIfNeeded();
    const again=await page.locator('#pad').boundingBox();
    const finger={x:again.x+80,y:again.y+40};
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[finger]});
    await page.waitForFunction(()=>window.denAudition.state().starting);
    await begun;
    await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[finger]});
    unblock();
    await page.waitForFunction(()=>window.denAudition.state().peak>0.01);
    await client.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await advance(0.25);assert((await peak())<1e-6,'renewed touch release stuck');
    await page.getByRole('button',{name:'Stop audio',exact:true}).tap();
    await page.waitForFunction(()=>window.denAudition.state().contextState==='closed');
    await page.unroute('**/*.wasm');
    // Cancel while worklet setup is delayed; completion must not reconnect audio.
    let signalRequest,finishRequest;
    const requested=new Promise(resolve=>{signalRequest=resolve;});
    const response=new Promise(resolve=>{finishRequest=resolve;});
    await page.route('**/*.wasm',async route=>{
      signalRequest();await response;await route.continue();
    });
    await page.getByRole('button',{name:'Start tone',exact:true}).tap();
    await requested; // ctx.resume has completed and createNode has begun loading.
    assert.equal((await state()).starting,true);
    await page.getByRole('button',{name:'Stop audio',exact:true}).tap();
    finishRequest();
    await page.waitForFunction(()=>window.denAudition.state().contextState==='closed');
    await page.waitForTimeout(400);
    assert.equal((await state()).contextState,'closed');
    assert.equal(await page.evaluate(()=>window.__contexts.every(c=>c.state==='closed')),true);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:join(artifacts,'mobile.png'),fullPage:true});
    for(const file of ['candidate-audition.wav','candidate-audition.json'])copyFileSync(join(consumer,file),join(artifacts,file));
    const root=join(import.meta.dirname,'..');
    const manifest={status:'CANDIDATE',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='',sources:Object.fromEntries(['src/envelope.ts','src/lfo.ts','src/oscillator.ts','tests/consumer/audition-processor.js','tests/consumer/audition.js','tests/consumer/audition-render.mjs','package-lock.json'].map(file=>[file,createHash('sha256').update(readFileSync(join(root,file))).digest('hex')])),audio:JSON.parse(readFileSync(join(consumer,'candidate-audition.json'),'utf8'))};
    writeFileSync(join(artifacts,'manifest.json'),JSON.stringify(manifest,null,2));
    writeFileSync(join(artifacts,'browser.json'),JSON.stringify({status:'CANDIDATE',browser:'Chromium touch emulation; not physical iOS/Android',sampleRate:48000,checks:['constructor failure and retry','no autoplay','gesture start','bounded output','zero gain silence','release silence','repeat start/stop','touch release','cancel startup','renewed hold during delayed startup'],state:await state()},null,2));
  } finally {
    try { await browser?.close(); }
    finally { if(server) await new Promise(resolve=>server.httpServer.close(resolve)); }
  }
});
