// One independently compiled module/composition per process, never parallel.
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {compile} from '@unworklet/core';
import {makeProcessor,makeProfileProcessor} from './processor.ts';
const kind=process.argv[2],count=Number(process.argv[3]);
assert(['resident','player','zones','grains','combined'].includes(kind));assert(Number.isInteger(count)&&count>=1&&count<=32);
const p=kind==='combined'?makeProcessor({zoneCount:1,grainCount:4}):makeProfileProcessor(kind,count);
const before=performance.now(),c=await compile(p,{sampleRate:48000}),compileMs=performance.now()-before,d=await c.driver.instantiate();
const memoryBytes=d.memory.buffer.byteLength;for(let n=0;n<16;n++)d.process();const times=[];
for(let n=0;n<32;n++){const t=performance.now();d.process();times.push(performance.now()-t);}times.sort((a,b)=>a-b);
assert.equal(d.memory.buffer.byteLength,memoryBytes);assert.equal(d.scrubbedSamples(),0);
console.log(JSON.stringify({kind,count,residentLoaded:false,sampleRate:48000,warmupBlocks:16,blocks:32,compileMs,wasmBytes:c.wasm.byteLength,memoryBytes,p50Ms:times[16],maximumMs:times.at(-1),maxRssKiB:process.resourceUsage().maxRSS,limitation:'Unloaded driver diagnostic; not actual audible browser/device performance'}));
