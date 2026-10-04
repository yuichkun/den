import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,copyFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {preview} from 'vite';
import {buildConsumer} from '../scripts/build-consumer.mjs';
import {delayReference,compare,peak as pcmPeak} from './integration-consumer/reference.mjs';
const root=join(import.meta.dirname,'..'),artifacts=join(root,'artifacts/integration',new Date().toISOString().replace(/[:.]/g,'-'));
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
test('private integration candidate: public packed imports, MIDI → instrument → stereo delay, peaks and lifecycle',{timeout:240000},async()=>{
 mkdirSync(artifacts,{recursive:true});console.log(`Evidence: ${artifacts}`);let browser,server;
 const manifest={status:'CANDIDATE',runtimeGate:'NOT_CLEARED',physicalListening:'UNVERIFIED',deployment:'LOCAL_ONLY',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='',sources:{},checks:[]};
 for(const file of ['package.json','package-lock.json','src/instrument.ts','src/filter.ts','src/delay-fx.ts','scripts/build-consumer.mjs',...readdirSync(join(root,'tests/integration-consumer')).map(f=>'tests/integration-consumer/'+f),'tests/integration.test.mjs'])manifest.sources[file]=sha(join(root,file));
 try{
  const {consumer,output,pack}=buildConsumer({fixture:'tests/integration-consumer',stageSite:false});manifest.pack={integrity:pack.integrity,shasum:pack.shasum};manifest.consumer=consumer;
  console.log(execFileSync('node',['render.mjs'],{cwd:consumer,encoding:'utf8'}));manifest.checks.push('public imports, strict TS, packed production build, independent offline MIDI/filter/delay references, coherent four-voice maximum-feedback peaks');
  for(const f of ['integration-candidate.wav','integration-numerical.json'])copyFileSync(join(consumer,f),join(artifacts,f));
  manifest.wasm=Object.fromEntries(readdirSync(join(output,'assets')).filter(f=>f.endsWith('.wasm')).map(f=>[f,{bytes:readFileSync(join(output,'assets',f)).length,sha256:sha(join(output,'assets',f))}]));
  server=await preview({root:consumer,configFile:false,build:{outDir:output},preview:{host:'127.0.0.1',port:0}});
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});manifest.browser=browser.version();
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   window.__contexts=[];window.__nodes=[];window.__analysers=[];
   const AC=AudioContext;window.AudioContext=class extends AC{constructor(...a){if(window.__failContext)throw Error('constructor probe');super(...a);window.__contexts.push(this);}};
   const AW=AudioWorkletNode;window.AudioWorkletNode=class extends AW{constructor(...a){super(...a);window.__nodes.push(this);}};
   const AN=AnalyserNode;window.AnalyserNode=class extends AN{constructor(...a){super(...a);window.__analysers.push(this);}};
  });
  const advance=async seconds=>{const t=await page.evaluate(s=>window.__contexts.at(-1).currentTime+s,seconds);await page.waitForFunction(t=>window.__contexts.at(-1).currentTime>=t,t);};
  const peak=()=>page.evaluate(()=>{const a=window.__analysers.at(-1),v=new Float32Array(a.fftSize);a.getFloatTimeDomainData(v);return v.reduce((p,x)=>Math.max(p,Math.abs(x)),0);});
  const set=(id,value)=>page.locator('#'+id).evaluate((el,v)=>{el.value=String(v);el.dispatchEvent(new Event('input',{bubbles:true}));},value);
  const stop=async()=>{await page.locator('#stop').tap();await page.waitForFunction(()=>window.denIntegration.state().contextState==='closed'&&!window.denIntegration.state().stopping&&!window.denIntegration.state().starting);};
  const ready=()=>page.waitForFunction(()=>window.denIntegration.state().ready);
  await page.goto(server.resolvedUrls.local[0]);assert.equal(await page.evaluate(()=>window.__contexts.length),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.evaluate(()=>window.__failContext=true);await page.locator('#start').tap();assert.match(await page.locator('#status').textContent(),/constructor probe/);await page.evaluate(()=>window.__failContext=false);
  await page.locator('#start').tap();await ready();assert.equal(await peak(),0);
  await set('volume',.1);await set('feedback',.5);await set('mix',1);await advance(.3);
  // Test-only observer taps the actual native source and FX nodes. Product route remains intact.
  await page.evaluate(async()=>{
   const ctx=window.__contexts.at(-1);await ctx.suspend();
   const code=`class Capture extends AudioWorkletProcessor{constructor(){super();this.at=0;this.data=[new Float32Array(32768),new Float32Array(32768),new Float32Array(32768)];}process(inputs){if(this.at<32768){for(let c=0;c<3;c++){const input=c===0?inputs[0]?.[0]:inputs[1]?.[c-1];if(input)this.data[c].set(input,this.at);}this.at+=128;if(this.at===32768)this.port.postMessage(this.data);}return true;}}registerProcessor('integration-capture',Capture);`;
   const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));await ctx.audioWorklet.addModule(url);URL.revokeObjectURL(url);
   const [instrument,delay]=window.__nodes;const cap=new AudioWorkletNode(ctx,'integration-capture',{numberOfInputs:2,numberOfOutputs:1,outputChannelCount:[1]});instrument.connect(cap,0,0);delay.connect(cap,0,1);cap.connect(ctx.destination);window.__capture=new Promise(resolve=>cap.port.onmessage=e=>resolve(e.data.map(v=>Array.from(v))));window.__cap=cap;
  });
  await page.locator('#chord').focus();await page.keyboard.down('Space');await page.evaluate(()=>window.__contexts.at(-1).resume());
  const recorded=await Promise.race([page.evaluate(()=>window.__capture),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('capture deadline')),15000);t.unref();})]);
  const errorsFx=recorded.slice(1).map((v,ch)=>compare(v,delayReference(recorded[0],48000,ch?.1875:.125,.5,1),6e-6));assert(pcmPeak(recorded[0])>.02);assert(recorded.slice(1).every(v=>pcmPeak(v)*.1<=.040001));assert(errorsFx.every(e=>e<6e-6));assert.notDeepEqual(recorded[1],recorded[2]);
  manifest.capture={frames:32768,error:errorsFx,sourcePeak:pcmPeak(recorded[0]),outputPeaks:recorded.slice(1).map(v=>pcmPeak(v)*.1)};
  writeFileSync(join(artifacts,'browser-capture.json'),JSON.stringify(recorded));await page.evaluate(()=>window.__cap.disconnect());
  await page.keyboard.up('Space');await advance(.3);assert((await peak())>1e-6,'delay tail missing after note off');
  await page.locator('#reset').tap();await advance(.15);assert((await peak())<1e-7,'panic did not clear notes and tail');
  await set('mix',0);await page.locator('#chord').focus();await page.keyboard.down('Space');await advance(.3);assert((await peak())>.003);assert((await peak())<=.040001);
  await set('volume',0);await advance(.35);assert((await peak())<1e-7);await page.keyboard.up('Space');await set('volume',.035);
  await page.screenshot({path:join(artifacts,'mobile.png'),fullPage:true});await stop();
  // Real touch cancellation and release, then repeated start/stop.
  const client=await context.newCDPSession(page);await page.locator('#key-0').scrollIntoViewIfNeeded();const box=await page.locator('#key-0').boundingBox(),finger={x:box.x+20,y:box.y+20};
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[finger]});await ready();await advance(.2);assert((await peak())>.0001);await client.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await advance(.4);assert((await peak())<1e-7);await stop();
  for(let n=0;n<2;n++){await page.locator('#start').tap();await ready();await stop();}
  // Observe real second-node loading so cancellation covers a partially allocated graph.
  let began,unblock;const begun=new Promise(r=>began=r),barrier=new Promise(r=>unblock=r);let requests=0;
  await page.route('**/*.wasm',async route=>{requests++;if(requests===2){began();await barrier;}await route.continue();});
  await page.locator('#start').tap();await Promise.race([begun,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('second WASM request missing')),15000);t.unref();})]);await stop();unblock();await page.waitForTimeout(300);await page.unroute('**/*.wasm');
  assert.equal(await page.evaluate(()=>window.__contexts.every(c=>c.state==='closed')),true);
  // A rejected second WASM request must dispose the already-created instrument.
  let rejectedRequests=0;await page.route('**/*.wasm',async route=>{if(++rejectedRequests===2)await route.abort('failed');else await route.continue();});
  await page.locator('#start').tap();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Audio unavailable:'));
  assert.equal(await page.evaluate(()=>window.__contexts.every(c=>c.state==='closed')),true);await page.unroute('**/*.wasm');
  // Renewal while async startup is pending preserves the latest hold.
  let first,release;const seen=new Promise(r=>first=r),wait=new Promise(r=>release=r);
  await page.route('**/*.wasm',async route=>{first();await wait;await route.continue();});
  await page.locator('#chord').focus();await page.keyboard.down('Space');await Promise.race([seen,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('WASM request missing')),15000);t.unref();})]);await page.keyboard.up('Space');await page.keyboard.down('Space');release();await ready();await advance(.25);assert((await peak())>.001);await page.keyboard.up('Space');await advance(.4);assert((await peak())<1e-7);await stop();await page.unroute('**/*.wasm');
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>window.__contexts.every(c=>c.state==='closed')),true);
  manifest.checks.push('real MIDI→instrument→stereo Delay wiring against captured-input oracle','maximum feedback/chord peaks','dry/wet, note-off tail, panic, zero volume','constructor failure/retry','touch cancel','repeated start/stop','second-node startup cancellation and fetch-failure disposal','renewed keyboard hold','no autoplay, mobile layout, all contexts closed, no page errors');manifest.result='PASS';
 }catch(error){manifest.result='FAIL';manifest.error=String(error);throw error;}
 finally{writeFileSync(join(artifacts,'manifest.json'),JSON.stringify(manifest,null,2));try{await browser?.close();}finally{if(server)await new Promise(r=>server.httpServer.close(r));}}
});
