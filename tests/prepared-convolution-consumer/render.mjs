import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { compile, inspect } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { prepareConvolutionSpectrum } from '@denaudio/den/prepared-convolution';
import processor from './processor.ts';

const config = { blockSize: 128, partitions: 64 }, B = 128;
const started = performance.now(), compiled = await compile(processor, { sampleRate: 48000 });
const compileMs = performance.now() - started, instance = await compiled.driver.instantiate();
const memoryBytes = instance.memory.buffer.byteLength;
const block = Float32Array.from({ length: B }, (_, n) => Math.sin(n * .13) * .5), zero = new Float32Array(B), output = new Float32Array(B);
instance.writeInput('main', 0, block); instance.writeInput('main', 1, zero);
const coldStart = performance.now(); instance.process(); const coldQuantumMs = performance.now() - coldStart;
const startup = [coldQuantumMs], times = [];
for (let n = 0; n < 127; n++) { const t = performance.now(); instance.process(); startup.push(performance.now() - t); }
for (let n = 0; n < 512; n++) {
  const t = performance.now(); instance.writeInput('main', 0, block); instance.writeInput('main', 1, zero); instance.process(); instance.readOutput('main', 0, output); times.push(performance.now() - t);
}
assert.equal(instance.memory.buffer.byteLength, memoryBytes); assert.equal(instance.scrubbedSamples(), 0);
const stats = values => { const sorted = [...values].sort((a,b) => a-b); return { count: values.length, p50Ms: sorted[Math.floor(sorted.length*.5)], p99Ms: sorted[Math.floor(sorted.length*.99)], maxMs: sorted.at(-1) }; };
const cost = { sampleRate: 48000, blockSize: B, partitions: 64, compileMs, coldQuantumMs, startupMaxQuantumMs: Math.max(...startup),
  wasmBytes: compiled.wasm.byteLength, wasmSha256: createHash('sha256').update(compiled.wasm).digest('hex'), memoryBytes,
  warmupBlocks: 128, measuredBlocks: 512, copyBytesPerQuantum: 1536, unloadedWithCopies: stats(times),
  payloadRingBytes: processor.worklet.messageRings[0].payloadContent.capacity,
  limitation: 'Fresh Node driver, no packet loaded: all FFT/MAC/OLA loops still execute. Loaded end-to-end timings below are separate. Not isolated handler, browser, concurrency or realtime acceptance.' };

let seed = 19;
const raw = Array.from({ length: 8192 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2**31 - 1; });
const norm = raw.reduce((sum,v) => sum+Math.abs(v),0), dense = raw.map(v=>v*3.9/norm);
const preparationStarted = performance.now(), densePacket = prepareConvolutionSpectrum(dense,config); cost.dense8192PreparationMs = performance.now()-preparationStarted;
const edge = Array.from({ length:8192 },(_,n)=>[0,127,128,8191].includes(n) ? .75 : 0), edgePacket = prepareConvolutionSpectrum(edge,config);
const short = [.5,-.25,.125], shortPacket = prepareConvolutionSpectrum(short,config);
const empty = {formatVersion:1,blockSize:128,partitions:64,impulseFrames:0,declaredValues:0,spectrum:new Float32Array()};
const reports=[];
for (const sampleRate of [44100,48000,96000]) {
  const frames=16384, input=Float32Array.from({length:frames},(_,n)=>n<12288?.45*Math.sin(n*.073)+.25*Math.cos(n*.311):0), reset=new Float32Array(frames);
  reset[255]=1; reset[2305]=1; reset.fill(1,6143,6148); reset[8191]=1;
  const bad={...densePacket,spectrum:densePacket.spectrum.slice()}; bad.spectrum[32767]=NaN;
  const loads=[{atQuantum:0,payload:densePacket,impulse:dense},{atQuantum:24,payload:bad,impulse:null,rejected:true},{atQuantum:32,payload:empty,impulse:null},{atQuantum:40,payload:edgePacket,impulse:edge},{atQuantum:72,payload:shortPacket,impulse:short}];
  const render=(begin,end,restore)=>renderOffline(processor,{sampleRate,duration:(end-begin-.25)/sampleRate,inputs:{main:[input.slice(begin,end),reset.slice(begin,end)]},messages:loads.filter(l=>l.atQuantum>=begin/B&&l.atQuantum<end/B).map(l=>({name:'ir',payload:l.payload,atQuantum:l.atQuantum-begin/B})),restore});
  const result=await render(0,frames); let impulse=null,start=0,revision=0,rejected=false,maxError=0;
  for(let n=0;n<frames;n++) {
    if(n%B===0) for(const l of loads.filter(l=>l.atQuantum===n/B)){impulse=l.impulse;start=n;revision++;rejected=l.rejected??false;}
    if(reset[n])start=n+1;
    if(n%127===0 || !impulse || n<512) {
      let expected=0;if(impulse)for(let k=0;k<impulse.length;k++)if(n-B-k>=start)expected+=input[n-B-k]*impulse[k];
      maxError=Math.max(maxError,Math.abs(expected-result.outputs.main[0][n]));
    }
    assert.equal(result.outputs.main[1][n],Number(!!impulse));assert.equal(result.outputs.main[2][n],Number(rejected));assert.equal(result.outputs.main[3][n],revision);
  }
  assert(maxError<5e-6);assert.equal(result.diagnostics.scrubbedSamples,0);
  for(const split of [3072,3200,4096,5120,6144,9216,9344]){
    const first=await render(0,split),resumed=await render(split,frames,first.state);
    assert.deepEqual(resumed.outputs.main,result.outputs.main.map(channel=>channel.slice(split)));assert.equal(resumed.diagnostics.scrubbedSamples,0);
  }
  const impulseInput=new Float32Array(10240);impulseInput[127]=1;
  const ir=await renderOffline(processor,{sampleRate,duration:(10240-.25)/sampleRate,inputs:{main:[impulseInput,new Float32Array(10240)]},messages:[{name:'ir',payload:edgePacket}]});
  let impulseError=0;for(let n=0;n<10240;n++)impulseError=Math.max(impulseError,Math.abs(ir.outputs.main[0][n]-(edge[n-B-127]??0)));
  assert(impulseError<5e-6);assert.equal(ir.diagnostics.scrubbedSamples,0);
  reports.push({sampleRate,taps:8192,originalFirError:maxError,fullImpulseError:impulseError,snapshotContinuations:7,snapshotContinuation:'bit-identical',scrubbedSamples:0});
}
// The public driver intentionally lacks native message ingress. Use the public
// offline renderer for queued-load timing, including its instantiate, enqueue,
// native handler+DSP, input/output copies and snapshot overhead. No subtraction
// or fabricated isolated-handler number is reported.
const endToEnd=[];
for(const queuedLoads of [0,1,16]) {
  const measured=[];
  for(let iteration=0;iteration<12;iteration++) {
    const t=performance.now(); const result=await renderOffline(processor,{sampleRate:48000,duration:(128-.25)/48000,inputs:{main:[block,zero]},messages:Array.from({length:queuedLoads},()=>({name:'ir',payload:densePacket}))});
    if(iteration>=2)measured.push(performance.now()-t);
    assert.equal(result.diagnostics.scrubbedSamples,0);assert.equal(inspect(result.state).slots['convolution/revision'].value,queuedLoads);
    assert.equal(result.outputs.main[1][0],Number(queuedLoads>0));
  }
  endToEnd.push({queuedLoads,coefficientValuesScanned:queuedLoads*32768,payloadBytesCopied:queuedLoads*131072,...stats(measured)});
}
cost.oneQuantumOfflineEndToEnd=endToEnd;cost.maxProcessRssBytes=process.resourceUsage().maxRSS*1024;
writeFileSync('prepared-convolution-results.json',JSON.stringify({status:'CANDIDATE',reports,cost},null,2));console.log(JSON.stringify({reports,cost}));
