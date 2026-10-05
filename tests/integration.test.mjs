import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,copyFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {preview} from 'vite';
import {buildConsumer} from '../scripts/build-consumer.mjs';
import {installVolumeMeter,readVolumeMeter,verifyGainAutomation} from './volume-browser.mjs';
import {delayReference,compare,peak as pcmPeak} from './integration-consumer/reference.mjs';
const root=join(import.meta.dirname,'..'),artifacts=join(root,'artifacts/integration',new Date().toISOString().replace(/[:.]/g,'-'));
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
test('integration candidate: public packed imports, MIDI → instrument → stereo delay, peaks and lifecycle',{timeout:240000},async()=>{
 mkdirSync(artifacts,{recursive:true});console.log(`Evidence: ${artifacts}`);let browser,server;
 const manifest={status:'CANDIDATE',runtimeGate:'NOT_CLEARED',physicalListening:'UNVERIFIED',deployment:'LOCAL_ONLY',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='',sources:{},checks:[]};
 for(const file of ['package.json','package-lock.json','src/instrument.ts','src/filter.ts','src/delay-fx.ts','src/delay-settings.ts','tests/fixtures/delay-settings.mjs','scripts/build-consumer.mjs',...readdirSync(join(root,'tests/integration-consumer')).map(f=>'tests/integration-consumer/'+f),'tests/integration.test.mjs','tests/volume-browser.mjs'])manifest.sources[file]=sha(join(root,file));
 try{
  const {consumer,output,pack}=buildConsumer({fixture:'tests/integration-consumer',stageSite:false});manifest.pack={integrity:pack.integrity,shasum:pack.shasum};manifest.consumer=consumer;
  writeFileSync(join(consumer,'delay-settings-reference.mjs'),readFileSync(join(root,'tests/fixtures/delay-settings.mjs'),'utf8').replace('../../dist/delay-fx.js','@denaudio/den/delay-fx'));
  console.log(execFileSync('node',['render.mjs'],{cwd:consumer,encoding:'utf8'}));manifest.checks.push('public imports, strict TS, packed production build, independent offline MIDI/filter/delay references, coherent four-voice maximum-feedback peaks');
  for(const f of ['integration-candidate.wav','integration-numerical.json','integration-chorus.wav','integration-rhythmic.wav','integration-settings-numerical.json'])copyFileSync(join(consumer,f),join(artifacts,f));
  manifest.wasm=Object.fromEntries(readdirSync(join(output,'assets')).filter(f=>f.endsWith('.wasm')).map(f=>[f,{bytes:readFileSync(join(output,'assets',f)).length,sha256:sha(join(output,'assets',f))}]));
  server=await preview({root:consumer,configFile:false,build:{outDir:output},preview:{host:'127.0.0.1',port:0}});
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});manifest.browser=browser.version();
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   window.__gainCalls=[];window.__masters=[];window.__contexts=[];window.__nodes=[];window.__analysers=[];window.__transports=[];
   const AC=AudioContext;window.AudioContext=class extends AC{constructor(...a){if(window.__failContext)throw Error('constructor probe');super(...a);window.__contexts.push(this);}};
   const AW=AudioWorkletNode;window.AudioWorkletNode=class extends AW{constructor(...a){super(...a);window.__nodes.push(this);window.__transports.push(a[2]?.processorOptions?.transport??null);}};
   const GN=GainNode;window.GainNode=class extends GN{constructor(...a){super(...a);window.__masters.push(this);if(a[0] instanceof window.AudioContext){for(const name of ["setTargetAtTime","linearRampToValueAtTime"]){const original=this.gain[name].bind(this.gain);this.gain[name]=(...args)=>{window.__gainCalls.push({name,args,now:a[0].currentTime});return original(...args);};}}}};
   const AN=AnalyserNode;window.AnalyserNode=class extends AN{constructor(...a){super(...a);window.__analysers.push(this);}};
  });
  const advance=async seconds=>{const t=await page.evaluate(s=>window.__contexts.at(-1).currentTime+s,seconds);await page.waitForFunction(t=>window.__contexts.at(-1).currentTime>=t,t);};
  const peak=()=>page.evaluate(()=>{const a=window.__analysers.at(-1),v=new Float32Array(a.fftSize);a.getFloatTimeDomainData(v);return v.reduce((p,x)=>Math.max(p,Math.abs(x)),0);});
  const set=(id,value)=>page.locator('#'+id).evaluate((el,v)=>{el.value=String(v);el.dispatchEvent(new Event('input',{bubbles:true}));},value);
  const stop=async()=>{await page.locator('#stop').tap();await page.waitForFunction(()=>window.denIntegration.state().contextState==='closed'&&!window.denIntegration.state().stopping&&!window.denIntegration.state().starting);};
  const ready=()=>page.waitForFunction(()=>window.denIntegration.state().ready);
  const response=await page.goto(server.resolvedUrls.local[0]);const headers=await response.allHeaders();manifest.delivery={server:"Vite preview, configFile:false",coop:headers["cross-origin-opener-policy"]??null,coep:headers["cross-origin-embedder-policy"]??null,...await page.evaluate(()=>({crossOriginIsolated,sharedArrayBuffer:typeof SharedArrayBuffer}))};manifest.gainAutomation=await verifyGainAutomation(page);assert.equal(await page.locator('#volume').inputValue(),'1');assert.equal(await page.locator('#volume').getAttribute('max'),'2');assert.equal(await page.evaluate(()=>window.__contexts.length),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.evaluate(()=>window.__failContext=true);await page.locator('#start').tap();assert.match(await page.locator('#status').textContent(),/constructor probe/);await page.evaluate(()=>window.__failContext=false);
  await page.locator('#start').tap();await ready();manifest.delivery.nodeTransports=await page.evaluate(()=>window.__transports.slice());assert.equal(manifest.delivery.crossOriginIsolated,false);assert.deepEqual(manifest.delivery.nodeTransports,['postMessage','postMessage'],'exercise both nodes through the production-observed fallback');assert.equal(await peak(),0);
  // UI-only samples exercise the real draw path; the audio graph stays intact.
  await page.evaluate(()=>{
   const analyser=window.__analysers.at(-1),original=analyser.getFloatTimeDomainData.bind(analyser);
   const pen=document.getElementById('waveform').getContext('2d'),begin=pen.beginPath.bind(pen),move=pen.moveTo.bind(pen),line=pen.lineTo.bind(pen);
   window.__restoreDisplay=()=>{analyser.getFloatTimeDomainData=original;pen.beginPath=begin;pen.moveTo=move;pen.lineTo=line;};
   pen.beginPath=()=>{window.__displayCoordinates=[];begin();};
   pen.moveTo=(x,y)=>{window.__displayCoordinates.push([x,y]);move(x,y);};pen.lineTo=(x,y)=>{window.__displayCoordinates.push([x,y]);line(x,y);};
   analyser.getFloatTimeDomainData=data=>{for(let i=0;i<data.length;i++)data[i]=.6259036660194397*Math.sin(2*Math.PI*i/256);data.set([1,-1,0,.6259036660194397,-.6259036660194397]);};
  });
  await page.waitForFunction(()=>window.__displayCoordinates?.length===2048);
  const display=await page.evaluate(()=>({width:document.getElementById('waveform').width,height:document.getElementById('waveform').height,points:window.__displayCoordinates}));
  assert(display.points.every(([x,y])=>x>=0&&x<display.width&&y>=2&&y<=display.height-2));
  assert.equal(display.points[0][1],2);assert.equal(display.points[1][1],display.height-2);assert.equal(display.points[2][1],display.height/2);
  assert(Math.abs(display.points[3][1]-(display.height/2-.6259036660194397*(display.height/2-2)))<1e-6);
  manifest.waveformScale={range:[-1,1],paddingPixels:2,measuredPeak:.6259036660194397,peakY:display.points[3][1],coordinatesInBounds:true};
  await page.screenshot({path:join(artifacts,'waveform-full-scale.png'),fullPage:true});await page.evaluate(()=>window.__restoreDisplay());
  await set('volume',2);await set('feedback',.5);await set('mix',1);await advance(.3);
  // Test-only observer taps the actual native source and FX nodes. Product route remains intact.
  await page.evaluate(async()=>{
   const ctx=window.__contexts.at(-1);await ctx.suspend();
   const code=`class Capture extends AudioWorkletProcessor{constructor(){super();this.at=0;this.data=[new Float32Array(32768),new Float32Array(32768),new Float32Array(32768)];}process(inputs){if(this.at<32768){for(let c=0;c<3;c++){const input=c===0?inputs[0]?.[0]:inputs[1]?.[c-1];if(input)this.data[c].set(input,this.at);}this.at+=128;if(this.at===32768)this.port.postMessage(this.data);}return true;}}registerProcessor('integration-capture',Capture);`;
   const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));await ctx.audioWorklet.addModule(url);URL.revokeObjectURL(url);
   const [instrument,delay]=window.__nodes;const cap=new AudioWorkletNode(ctx,'integration-capture',{numberOfInputs:2,numberOfOutputs:1,outputChannelCount:[1]});instrument.connect(cap,0,0);delay.connect(cap,0,1);cap.connect(ctx.destination);window.__capture=new Promise(resolve=>cap.port.onmessage=e=>resolve(e.data.map(v=>Array.from(v))));window.__cap=cap;
  });
  await page.locator('#chord').focus();await page.keyboard.down('Space');await page.evaluate(()=>window.__contexts.at(-1).resume());
  const recorded=await Promise.race([page.evaluate(()=>window.__capture),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('capture deadline')),15000);t.unref();})]);
  const errorsFx=recorded.slice(1).map((v,ch)=>compare(v,delayReference(recorded[0],48000,ch?.1875:.125,.5,1),6e-6));assert(pcmPeak(recorded[0])>.02);assert(recorded.slice(1).every(v=>pcmPeak(v)*2<=.800001));assert(errorsFx.every(e=>e<6e-6));assert.notDeepEqual(recorded[1],recorded[2]);
  manifest.capture={frames:32768,error:errorsFx,sourcePeak:pcmPeak(recorded[0]),outputPeaks:recorded.slice(1).map(v=>pcmPeak(v)*2)};
  writeFileSync(join(artifacts,'browser-capture.json'),JSON.stringify(recorded));await page.evaluate(()=>window.__cap.disconnect());
  await page.keyboard.up('Space');await advance(.3);assert((await peak())>1e-6,'delay tail missing after note off');
  await page.locator('#reset').tap();await advance(.15);assert((await peak())<1e-7,'panic did not clear notes and tail');
  await set('mix',0);await page.locator('#chord').focus();await page.keyboard.down('Space');await advance(.3);assert((await peak())>.003);assert((await peak())<=.800001);
  await set('volume',0);await advance(.35);assert((await peak())<1e-7);await page.keyboard.up('Space');await set('volume',1);
  await page.screenshot({path:join(artifacts,'mobile.png'),fullPage:true});await stop();
  // Real touch cancellation and release, then repeated start/stop.
  const client=await context.newCDPSession(page);await page.locator('#key-0').scrollIntoViewIfNeeded();const box=await page.locator('#key-0').boundingBox(),finger={x:box.x+20,y:box.y+20};
  await client.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[finger]});await ready();await advance(.2);assert((await peak())>.0001);await client.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await advance(.4);assert((await peak())<1e-7);await stop();
  for(let n=0;n<2;n++){await page.locator('#start').tap();await ready();await stop();}
  // Observe real second-node loading so cancellation covers a partially allocated graph.
  let began,unblock;const begun=new Promise(r=>began=r),barrier=new Promise(r=>unblock=r);let requests=0;
  await page.route('**/*.wasm',async route=>{requests++;if(requests===2){began();await barrier;}await route.continue();});
  await page.locator('#start').tap();assert(await page.locator('#effect').isDisabled());await Promise.race([begun,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('second WASM request missing')),15000);t.unref();})]);await stop();unblock();await page.waitForTimeout(300);await page.unroute('**/*.wasm');
  assert.equal(await page.evaluate(()=>window.__contexts.every(c=>c.state==='closed')),true);
  // A rejected second WASM request must dispose the already-created instrument.
  let rejectedRequests=0;await page.route('**/*.wasm',async route=>{if(++rejectedRequests===2)await route.abort('failed');else await route.continue();});
  await page.locator('#start').tap();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('Audio unavailable:'));
  assert.equal(await page.evaluate(()=>window.__contexts.every(c=>c.state==='closed')),true);await page.unroute('**/*.wasm');
  // Renewal while async startup is pending preserves the latest hold.
  let first,release;const seen=new Promise(r=>first=r),wait=new Promise(r=>release=r);
  await page.route('**/*.wasm',async route=>{first();await wait;await route.continue();});
  await page.locator('#chord').focus();await page.keyboard.down('Space');await Promise.race([seen,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('WASM request missing')),15000);t.unref();})]);await page.keyboard.up('Space');await page.keyboard.down('Space');release();await ready();await advance(.25);assert((await peak())>.001);await page.keyboard.up('Space');await advance(.4);assert((await peak())<1e-7);await stop();await page.unroute('**/*.wasm');
  manifest.settings=[];
  for(const [name,mix,feedback] of [['diagnostic',.35,.25],['chorus',.45,0],['rhythmic',.35,.48]]){
   assert.equal(await page.locator('#effect').isDisabled(),false);await page.selectOption('#effect',name);
   const state=await page.evaluate(()=>window.denIntegration.state());assert.equal(state.selected,name);assert.equal(state.controls.mix,mix);assert.equal(state.controls.feedback,feedback);assert.equal(state.contextState,'closed');
   await page.locator('#start').tap();await ready();assert(await page.locator('#effect').isDisabled());
   const native=await page.evaluate(()=>{const node=window.__nodes.at(-1);return {mix:node.parameters.get('mix').value,feedback:node.parameters.get('feedback').value,transport:window.__transports.at(-1)};});
   assert(Math.abs(native.mix-mix)<1e-6);assert(Math.abs(native.feedback-feedback)<1e-6);assert.equal(native.transport,'postMessage');
   await page.locator('#effect').evaluate(el=>{el.value='diagnostic';el.dispatchEvent(new Event('change',{bubbles:true}));});assert.equal(await page.locator('#effect').inputValue(),name);
   assert.equal(await page.evaluate(()=>window.denIntegration.state().activeEffect),name);
   await installVolumeMeter(page);
   await set('volume',2);await set('feedback',.5);await set('mix',1);await advance(.3);
   await page.locator('#chord').focus();await page.keyboard.down('Space');await advance(1.1);const maximumPeak=await peak();assert(maximumPeak>.001&&maximumPeak<=.800001);
   const levels={maximum:await readVolumeMeter(page)};
   for(const value of [1,0,2,-1,4]){await set('volume',value);await advance(.3);await readVolumeMeter(page);await advance(.25);levels[value]=await readVolumeMeter(page);assert.equal(Number(await page.locator("#volume").inputValue()),Math.max(0,Math.min(2,value)));if(value<=0)assert(levels[value].peak.every(p=>p<1e-7));else assert(levels[value].peak.some(p=>p>.001));}
   await set('volume',0);await advance(.01);await set('volume',2);await advance(.01);await set('volume',1);await advance(.3);levels.rapidChanges=await readVolumeMeter(page);
   await page.keyboard.up('Space');await advance(.25);levels.release=await readVolumeMeter(page);assert((await peak())>1e-6);
   await page.locator('#reset').tap();await advance(.15);assert((await peak())<1e-7);
   levels.reset=await readVolumeMeter(page);
   await page.screenshot({path:join(artifacts,'mobile-'+name+'.png'),fullPage:true});
   manifest.settings.push({name,initial:native,maximumPeak,levels});
   await stop();assert.equal(await page.locator('#effect').isDisabled(),false);
  }
  manifest.gainCalls=await page.evaluate(()=>window.__gainCalls);assert(manifest.gainCalls.some(c=>c.name==='linearRampToValueAtTime'));for(const c of manifest.gainCalls){if(c.name==='setTargetAtTime'){assert(c.args[0]>=0&&c.args[0]<=2);assert.equal(c.args[2],.015);}else{assert.equal(c.args[0],0);assert(Math.abs(c.args[1]-c.now-.02)<1e-9);}}
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>window.__contexts.every(c=>c.state==='closed')),true);
  manifest.checks.push('real MIDI→instrument→stereo Delay wiring against captured-input oracle','maximum feedback/chord peaks','dry/wet, note-off tail, panic, zero volume','constructor failure/retry','touch cancel','repeated start/stop','second-node startup cancellation and fetch-failure disposal','renewed keyboard hold','no autoplay, mobile layout, all contexts closed, no page errors','chorus/rhythmic public settings, stopped-only switching, selected native defaults and fallback transport, maximum-feedback chord peaks, release tails, reset and stop');manifest.result='PASS';
 }catch(error){manifest.result='FAIL';manifest.error=String(error);throw error;}
 finally{writeFileSync(join(artifacts,'manifest.json'),JSON.stringify(manifest,null,2));try{await browser?.close();}finally{if(server)await new Promise(r=>server.httpServer.close(r));}}
});
