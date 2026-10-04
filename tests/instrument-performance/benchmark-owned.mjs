import {compile} from '@unworklet/core';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const source=resolve(process.env.PROPOSALS_DIR),out=resolve('artifacts/instrument-investigation',new Date().toISOString().replaceAll(':','-')+'-owned-timing');mkdirSync(out,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifest={source,sourceManifestHash:hash(readFileSync(join(source,'manifest.json'))),node:process.version,activeVoices:0,heldCapacity:128,sampleRate:48000,blocks:2500,warmupBlocks:500,results:[],limitation:'Inactive-voice Node cost. Process CPU includes all threads. This is not a browser latency measurement.'};
writeFileSync(join(out,'benchmark-owned.mjs'),readFileSync(import.meta.filename));
for(const capacity of [1,4])for(const name of ['baseline','depths']){
 const module=await import(join(source,name,'dist/instrument.js')),start=performance.now(),compiled=await compile(module.createInstrument({mode:'poly',capacity,heldCapacity:128}),{sampleRate:48000}),compileMs=performance.now()-start,init=performance.now(),instance=await compiled.driver.instantiate(),instantiateMs=performance.now()-init;
 const wallUs=[],processCpuUs=[],raw=new Float32Array(2500*128),block=new Float32Array(128);
 for(let b=0;b<2500;b++){const cpu=process.cpuUsage(),start=performance.now();instance.process();wallUs.push((performance.now()-start)*1000);const elapsed=process.cpuUsage(cpu);processCpuUs.push(elapsed.user+elapsed.system);instance.readOutput('main',0,block);raw.set(block,b*128);}
 const sorted=wallUs.slice(500).sort((a,b)=>a-b),pcm=Buffer.from(raw.buffer),result={name,capacity,wasmBytes:compiled.wasm.length,wasmHash:hash(compiled.wasm),compileMs,instantiateMs,firstBlockUs:wallUs[0],hotMedianUs:sorted[sorted.length>>1],rawHash:hash(pcm),wallUs,processCpuUs};
 writeFileSync(join(out,`${name}-${capacity}.wasm`),compiled.wasm);writeFileSync(join(out,`${name}-${capacity}.f32`),pcm);writeFileSync(join(out,`${name}-${capacity}.json`),JSON.stringify(result));manifest.results.push({...result,wallUs:undefined,processCpuUs:undefined});writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest.results.at(-1)));
}
console.log('Evidence:',out);
