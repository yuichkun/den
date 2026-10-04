import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { encodeWav } from '@unworklet/offline';
const root = resolve(import.meta.dirname, '..');
const run = (command, args, cwd) => execFileSync(command, command === 'npm' ? ['--cache', join(tmpdir(), 'den-npm-cache'), ...args] : args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('packed instrument module: isolated typecheck/offline render and real 48 kHz browser MIDI/parameters/reset', { timeout: 180000 }, async () => {
  const consumer = mkdtempSync(join(tmpdir(), 'den-instrument-'));
  cpSync(join(root, 'tests/consumer'), consumer, { recursive: true });
  cpSync(join(root, 'tests/instrument-consumer'), consumer, { recursive: true });
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2023', 'DOM'] }, include: ['processor.ts','sustained-processor.ts'] }));
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', consumer], root));
  assert(pack.files.some(f => f.path === 'dist/instrument.d.ts'));
  copyFileSync(join(consumer, pack.filename), join(consumer, 'den.tgz'));
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity = pack.integrity;
  writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock));
  run('npm', ['ci', '--include=dev', '--ignore-scripts'], consumer);
  run('npm', ['run', 'check'], consumer);
  run('node', ['render.mjs'], consumer);
  run('npm', ['run', 'build'], consumer);
  const wasmFiles = readdirSync(join(consumer,'dist/assets')).filter(file=>file.endsWith('.wasm'));
  const wasm = Object.fromEntries(wasmFiles.map(file=>[file,{bytes:readFileSync(join(consumer,'dist/assets',file)).length,sha256:hash(join(consumer,'dist/assets',file))}]));
  assert(wasmFiles.some(file=>file.startsWith('sustained-processor-')));
  console.log('Packed instrument WASM:',JSON.stringify(wasm));
  const { preview } = await import(pathToFileURL(join(consumer, 'node_modules/vite/dist/node/index.js')).href);
  const server = await preview({ root: consumer, configFile: false, preview: { host: '127.0.0.1', port: 0 } });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => typeof window.runInstrument === 'function');
    const result = await page.evaluate(() => window.runInstrument());
    assert.equal(result.sampleRate, 48000);
    for (const name of ['silent','bypassed','reset','ended','endedWhileBypassed']) assert.equal(result[name].peak, 0, name);
    for (const name of ['single','changed','filtered','resumed','chord','oneRelease','restarted']) {
      assert(result[name].finite, name); assert(result[name].rms > 0, name);
    }
    assert(Math.abs(result.changed.rms / result.single.rms - 0.5) < 0.03);
    assert(result.filtered.rms < result.changed.rms / 10);
    assert(Math.abs(result.resumed.rms / result.single.rms - 1) < 0.05);
    assert(Math.abs(result.chord.rms / result.single.rms - 2) < 0.1);
    assert(Math.abs(result.oneRelease.rms / result.single.rms - 1) < 0.05);
    const traceSession=await browser.newBrowserCDPSession();
    await traceSession.send('Tracing.start',{categories:'audio,webaudio,disabled-by-default-audio,disabled-by-default-audio-worklet,disabled-by-default-audio.latency',transferMode:'ReturnAsStream'});
    const sustained = await page.evaluate(() => window.runSustainedInstrument());
    const tracingDone=new Promise(resolve=>traceSession.once('Tracing.tracingComplete',resolve));
    await traceSession.send('Tracing.end');
    const traceResult=await tracingDone;
    let traceText='';
    for(;;){const part=await traceSession.send('IO.read',{handle:traceResult.stream});traceText+=part.data;if(part.eof)break;}
    await traceSession.send('IO.close',{handle:traceResult.stream});
    const trace=JSON.parse(traceText);
    const measurementDir=join(root,'artifacts/instrument');mkdirSync(measurementDir,{recursive:true});
    writeFileSync(join(measurementDir,'sustained-browser-trace.json.gz'),gzipSync(traceText));
    writeFileSync(join(measurementDir,'sustained-browser.wav'),encodeWav([Float32Array.from(sustained.audio)],48000));
    const renders=trace.traceEvents.filter(e=>e.name==='RealtimeAudioDestinationHandler::Render'&&e.ph==='X'&&e.args?.frames===128);
    const budgetUs=128/48000*1e6;
    const summarize=events=>{
      const wall=events.map(e=>e.dur).sort((a,b)=>a-b),cpu=events.map(e=>e.tdur).sort((a,b)=>a-b);
      assert(events.length>0&&wall.every(Number.isFinite)&&cpu.every(Number.isFinite));
      const percentile=(values,p)=>values[Math.floor((values.length-1)*p)];
      return {count:events.length,wallP50Us:percentile(wall,0.5),wallP99Us:percentile(wall,0.99),wallMaxUs:wall.at(-1),
        cpuP50Us:percentile(cpu,0.5),cpuP99Us:percentile(cpu,0.99),cpuMaxUs:cpu.at(-1),
        wallQuantumOverruns:wall.filter(x=>x>budgetUs).length,cpuQuantumOverruns:cpu.filter(x=>x>budgetUs).length};
    };
    // Counterexample proves the deadline detector does not merely emit green.
    assert.equal(summarize([{dur:budgetUs*2,tdur:budgetUs*2}]).wallQuantumOverruns,1);
    assert(renders.length>4500,'Missing real-time render trace');
    const timing={budgetUs,wasm,all:summarize(renders),steady:summarize(renders.slice(Math.ceil(48000/128))),warmupFramesExcluded:48000};
    const realtimeStatus=timing.steady.wallQuantumOverruns===0?'NO_OBSERVED_QUANTUM_OVERRUN':'QUANTUM_OVERRUNS_REQUIRE_REVIEW';
    console.log('Instrument real-time timing:',JSON.stringify({realtimeStatus,...timing}));
    writeFileSync(join(measurementDir,'sustained-timing.json'),JSON.stringify({realtimeStatus,...timing},null,2));
    assert.equal(sustained.sampleRate,48000);
    assert.equal(sustained.audio.length,12*48000);
    console.log('Sustained observer frame gaps:',JSON.stringify(sustained.gaps));
    assert.deepEqual(sustained.gaps,[]);
    assert.deepEqual(sustained.errors.filter(e=>JSON.parse(e).code!=='sab-unavailable'),[]);
    assert(sustained.audio.every(Number.isFinite));
    // Fit only the initial steady window; predict all later samples from the
    // independent 440 Hz sinusoid. This exposes skipped/repeated quanta, periodic
    // phase resets and discontinuities that short RMS captures cannot detect.
    const omega=2*Math.PI*440/48000;
    let cc=0,ss=0,cs=0,xc=0,xs=0;
    for(let n=0;n<4096;n++){const c=Math.cos(omega*n),v=Math.sin(omega*n),x=sustained.audio[n];cc+=c*c;ss+=v*v;cs+=c*v;xc+=x*c;xs+=x*v;}
    const det=cc*ss-cs*cs,cosine=(xc*ss-xs*cs)/det,sine=(xs*cc-xc*cs)/det;
    const amplitude=Math.hypot(cosine,sine);
    const w=2*Math.PI*1000/48000,alpha=Math.sin(w),a0=1+alpha;
    const b0=(1-Math.cos(w))/2/a0,a1=-2*Math.cos(w)/a0,a2=(1-alpha)/a0;
    const numerator=b0*Math.hypot(1+2*Math.cos(omega)+Math.cos(2*omega),-2*Math.sin(omega)-Math.sin(2*omega));
    const denominator=Math.hypot(1+a1*Math.cos(omega)+a2*Math.cos(2*omega),-a1*Math.sin(omega)-a2*Math.sin(2*omega));
    assert(Math.abs(amplitude-4*0.02*numerator/denominator)<2e-5);
    let maxResidual=0,maxStep=0;
    for(let n=0;n<7*48000;n++)maxResidual=Math.max(maxResidual,Math.abs(sustained.audio[n]-cosine*Math.cos(omega*n)-sine*Math.sin(omega*n)));
    for(let n=1;n<sustained.audio.length;n++)maxStep=Math.max(maxStep,Math.abs(sustained.audio[n]-sustained.audio[n-1]));
    assert(maxResidual<2e-5,`sustained continuity residual ${maxResidual}`);
    assert(maxStep<amplitude*2*Math.sin(omega/2)+amplitude/48000+2e-5,`discontinuity ${maxStep}`);
    assert(sustained.audio.slice(10*48000).every(x=>x===0));
    // Exactly one contiguous one-second decay, using independently specified
    // duration and the observed termination boundary (delivery is block based).
    let end=sustained.audio.length-1;while(end>=0&&sustained.audio[end]===0)end--;
    assert(end>8*48000&&end<10*48000);
    let tailResidual=0;
    for(let n=end-48000+1;n<=end;n++) {
      const level=(end+1-n)/48000;
      tailResidual=Math.max(tailResidual,Math.abs(sustained.audio[n]-(cosine*Math.cos(omega*n)+sine*Math.sin(omega*n))*level));
    }
    assert(tailResidual<2e-5,`release continuity residual ${tailResidual}`);
    const artifacts = join(root, 'artifacts/instrument'); mkdirSync(artifacts, { recursive: true });
    const files = {};
    for (const file of ['den.tgz', 'package-lock.json', 'instrument-evidence.json', ...[44100, 48000, 96000].flatMap(rate => [`instrument-${rate}.wav`, `instrument-${rate}.svg`])]) {
      copyFileSync(join(consumer, file), join(artifacts, file)); files[file] = hash(join(artifacts, file));
    }
    writeFileSync(join(artifacts, 'browser.json'), JSON.stringify(result, null, 2)); files['browser.json'] = hash(join(artifacts, 'browser.json'));
    writeFileSync(join(artifacts,'sustained-browser.wav'),encodeWav([Float32Array.from(sustained.audio)],48000));
    for(const file of ['sustained-browser.wav','sustained-browser-trace.json.gz','sustained-timing.json'])files[file]=hash(join(artifacts,file));
    const evidence = JSON.parse(readFileSync(join(consumer, 'instrument-evidence.json'), 'utf8'));
    const sustainedEvidence={...sustained,audio:undefined,realtimeStatus,timing,amplitude,maxResidual,maxStep,tailResidual,releaseEndFrame:end,
      settings:{mode:'poly',capacity:4,heldCapacity:128,waveform:'sine',note:69,voices:4,velocity:127},
      parameters:{...evidence.parameters,gain:0.02,ampAttack:0,ampDecay:0,ampSustain:1,ampRelease:1,cutoff:1000,resonance:0.5,pitchEnvelopeDepth:0,filterEnvelopeDepth:0,lfoAmpDepth:0,lfoPitchDepth:0,lfoFilterDepth:0},
      limitation:'Raw graph continuity and Chrome render-quantum timing are measured, not hardware loopback. Quantum overruns are retained as a separate readiness finding even when numerical tests pass.'};
    writeFileSync(join(artifacts,'sustained-browser.json'),JSON.stringify(sustainedEvidence,null,2));
    files['sustained-browser.json']=hash(join(artifacts,'sustained-browser.json'));
    const points=Array.from({length:1200},(_,n)=>{const slice=sustained.audio.slice(n*480,n*480+480);return `${40+n},${130-1000*slice.reduce((p,x)=>Math.abs(x)>Math.abs(p)?x:p,0)}`;}).join(' ');
    writeFileSync(join(artifacts,'sustained-browser.svg'),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 260"><title>CANDIDATE: 12-second real-time instrument capture</title><text x="40" y="25">CANDIDATE: 4 voices, 48 kHz, 12 seconds; vertical scale ±0.1</text><path d="M40 30V230H1240M40 130H1240" stroke="gray" fill="none"/><polyline points="${points}" fill="none" stroke="blue"/></svg>`);
    files['sustained-browser.svg']=hash(join(artifacts,'sustained-browser.svg'));
    writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify({
      ...evidence, realtimeStatus, sourceCommit: run('git', ['rev-parse', 'HEAD'], root).trim(),
      sourceDirty: run('git', ['status', '--porcelain'], root).trim() !== '',
      sourceHashes: Object.fromEntries(['src/instrument.ts','src/instrument-example.ts','src/envelope.ts','src/lfo.ts','src/filter.ts','src/oscillator.ts','src/voice-policy.ts','tests/instrument.spec.ts','tests/instrument-packed.test.mjs','tests/instrument-consumer/processor.ts','tests/instrument-consumer/sustained-processor.ts','tests/instrument-consumer/main.js','tests/instrument-consumer/render.mjs','package-lock.json'].map(file => [file,hash(join(root,file))])),
      unworklet:'0.4.1', channels:2, offlineSampleRates:[44100,48000,96000], browserSampleRates:[48000],
      verification:'Independent DSP and voice tests; packed TypeScript/build/offline render; browser MIDI, polyphony, release, gain/cutoff edits, bypass, reset',
      limitations:['Not human approved','Physical packed module import; public export pending integration','MIDI dispatch is quantum-boundary'],files,
    },null,2));
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()));
  }
});
