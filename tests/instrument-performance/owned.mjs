// Isolated instrument-only variants; no shared DSP source changes.
import {readFileSync,writeFileSync,mkdirSync,readdirSync,symlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {compile,defineSubgraph,f32} from '@unworklet/core';
import {renderOffline} from '@unworklet/offline';
const root=process.cwd(),out=resolve('artifacts/instrument-investigation',new Date().toISOString().replaceAll(':','-')+'-owned');mkdirSync(out,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
const baselineCommit=process.env.BASELINE_COMMIT??'9a75f9c07e89d0dd77d598bf3e35ee51af1eb26e';
const baseline=execFileSync('git',['show',baselineCommit+':src/instrument.ts'],{encoding:'utf8'});
const depths=baseline.replace('    const signals =', "    const depths = state.buffer.f32({size:2*policy.capacity}).expose({name:'depths',snapshot:'transient'});\n    const signals =")
 .replace('          signals.write(n * 5 + 3, modulatePitch', '          depths.write(n*2,semitones);\n          depths.write(n*2+1,octaves);\n          signals.write(n * 5 + 3, modulatePitch')
 .replace('f32(1), semitones,','f32(1), depths.read(n*2),').replace('f32(1), octaves,','f32(1), depths.read(n*2+1),');
const mixed=depths.replace('    const signals =', "    const mix = state.f32(0).expose({name:'mix',snapshot:'transient'});\n    const signals =")
 .replace('        output.ch(0).at(i).write(result);\n        output.ch(1).at(i).write(result);','        mix.write(result);\n        output.ch(0).at(i).write(mix.read());\n        output.ch(1).at(i).write(mix.read());');
const manifest={baselineCommit,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),node:process.version,variants:[],comparisons:[],status:'CANDIDATE',limitations:['Process CPU includes compilation and all threads','Offline timing is not browser timing']};
const modules={};
for(const [name,instrument] of [['baseline',baseline],['depths',depths],['mixed',mixed]]){
 const dir=join(out,name);mkdirSync(join(dir,'src'),{recursive:true});mkdirSync(join(dir,'dist'),{recursive:true});symlinkSync(join(root,'node_modules'),join(dir,'node_modules'));writeFileSync(join(dir,'package.json'),'{"type":"module"}');const sourceHashes={};
 for(const file of readdirSync('src').filter(x=>x.endsWith('.ts'))){const source=file==='instrument.ts'?instrument:execFileSync('git',['show',baselineCommit+':src/'+file],{encoding:'utf8'});writeFileSync(join(dir,'src',file),source);writeFileSync(join(dir,'dist',file.replace('.ts','.js')),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText);sourceHashes[file]=hash(source);}
 modules[name]=await import(join(dir,'dist/instrument.js'));manifest.variants.push({name,sourceHashes});
}
const dc=defineSubgraph(_=>({tick:()=>f32(1)})),wire=defineSubgraph(_=>({tick:x=>x}));
const params={gain:[1],ampAttack:[0],ampDecay:[0],ampSustain:[1],ampRelease:[0.1],pitchEnvelopeDepth:[0],filterEnvelopeDepth:[0],lfoAmpDepth:[0],lfoPitchDepth:[0],lfoFilterDepth:[0],cutoff:[1000],resonance:[0.5]};
const notes=capacity=>Array.from({length:capacity},(_,n)=>({name:'midi',payload:{type:'noteOn',note:69+n*3,velocity:127,channel:0},atSample:0}));
const scenarios=['normal','dynamic','reset','restore','custom','tiny-output','tiny-depth'];
for(const capacity of [1,4])for(const sampleRate of [44100,48000,96000])for(const scenario of scenarios){
 const results={};
 for(const [name,module] of Object.entries(modules)){
  if(name==='mixed'&&scenario!=='tiny-output')continue;
  const custom=['custom','tiny-output'].includes(scenario),processor=module.createInstrument({mode:'poly',capacity,heldCapacity:128,...(custom?{oscillator:dc,filter:wire}:{})});
  const controls={...params};if(scenario==='dynamic'){controls.cutoff=Array.from({length:1024},(_,n)=>500+n*5);controls.lfoPitchDepth=[2];controls.lfoFilterDepth=[1];controls.lfoRate=[20];controls.gain=Array.from({length:1024},(_,n)=>n/1024);}
  if(scenario==='tiny-output')controls.gain=[1e-35];if(scenario==='tiny-depth'){controls.pitchSustain=[1];controls.pitchDecay=[0];controls.pitchEnvelopeDepth=[1e-35];controls.filterEnvelopeDepth=[-1e-35];}
  const config={sampleRate,duration:1024/sampleRate,params:controls,events:[...notes(capacity),{name:'midi',payload:{type:'noteOff',note:69,velocity:0,channel:0},atSample:512}]};
  if(scenario==='reset')config.messages=[{name:'reset',payload:{value:1},atQuantum:3}];
  if(scenario==='restore'){const first=await renderOffline(processor,{...config,duration:128/sampleRate});config.restore=first.state;}
  const rendered=await renderOffline(processor,config);const bytes=Buffer.from(rendered.outputs.main[0].buffer);const file=`${name}-${capacity}-${sampleRate}-${scenario}.f32`;writeFileSync(join(out,file),bytes);results[name]={bytes,file,hash:hash(bytes),scrubbed:rendered.diagnostics.scrubbedSamples};
 }
 const comparison={capacity,sampleRate,scenario,results:Object.fromEntries(Object.entries(results).map(([name,r])=>[name,{file:r.file,hash:r.hash,scrubbed:r.scrubbed,bitIdentical:r.bytes.equals(results.baseline.bytes)}]))};manifest.comparisons.push(comparison);writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify(comparison));
}
for(const capacity of [1,4])for(const name of ['baseline','depths']){
 const cpu=process.cpuUsage(),start=performance.now(),compiled=await compile(modules[name].createInstrument({mode:'poly',capacity,heldCapacity:128}),{sampleRate:48000});const compileMs=performance.now()-start,compileCpu=process.cpuUsage(cpu);writeFileSync(join(out,`${name}-${capacity}.wasm`),compiled.wasm);const init=performance.now(),instance=await compiled.driver.instantiate(),instantiateMs=performance.now()-init,wallUs=[],processCpuUs=[],raw=new Float32Array(2500*128),block=new Float32Array(128);
 for(let b=0;b<2500;b++){const cpu=process.cpuUsage(),start=performance.now();instance.process();wallUs.push((performance.now()-start)*1000);const elapsed=process.cpuUsage(cpu);processCpuUs.push(elapsed.user+elapsed.system);instance.readOutput('main',0,block);raw.set(block,b*128);}
 writeFileSync(join(out,`${name}-${capacity}-timing.f32`),Buffer.from(raw.buffer));const sorted=wallUs.slice(500).sort((a,b)=>a-b);const result={name,capacity,wasmBytes:compiled.wasm.length,wasmHash:hash(compiled.wasm),compileMs,compileCpu,instantiateMs,firstBlockUs:wallUs[0],hotMedianUs:sorted[sorted.length>>1],wallUs,processCpuUs};writeFileSync(join(out,`${name}-${capacity}-timing.json`),JSON.stringify(result));console.log(JSON.stringify({...result,wallUs:undefined,processCpuUs:undefined}));
}
writeFileSync(join(out,'owned.mjs'),readFileSync(import.meta.filename));writeFileSync(join(out,'package-lock.json'),readFileSync('package-lock.json'));console.log('Evidence:',out);
