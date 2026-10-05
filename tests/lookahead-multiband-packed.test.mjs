import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const run=(cmd,args,cwd)=>execFileSync(cmd,cmd==='npm'?['--cache',process.env.npm_config_cache??join(tmpdir(),'den-npm-cache'),...args]:args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
test('packed lookahead limiter and multiband public exports: independent 3-rate audio/state/cost evidence',{timeout:240000},()=>{
 const consumer=mkdtempSync(join(tmpdir(),'den-lookahead-multiband-'));
 cpSync(join(root,'tests/consumer'),consumer,{recursive:true});cpSync(join(root,'tests/lookahead-multiband-consumer'),consumer,{recursive:true});
 const[pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));
 for(const entry of ['lookahead-limiter','multiband-dynamics'])for(const ext of ['js','d.ts'])assert(pack.files.some(f=>f.path===`dist/${entry}.${ext}`));
 copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));
 const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock));
 run('npm',['ci','--include=dev','--ignore-scripts','--prefer-offline'],consumer);
 const installed=JSON.parse(readFileSync(join(consumer,'node_modules/@denaudio/den/package.json'),'utf8'));
 for(const entry of ['lookahead-limiter','multiband-dynamics'])assert.deepEqual(installed.exports[`./${entry}`],{types:`./dist/${entry}.d.ts`,import:`./dist/${entry}.js`});
 writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,types:[],lib:['ES2023','DOM']},include:['processor.ts']}));
 run('npm',['run','check'],consumer);console.log(run('node',['render.mjs'],consumer));
 const commit=run('git',['rev-parse','HEAD'],root).trim(),trial=`${new Date().toISOString().replaceAll(':','-')}-${commit.slice(0,7)}`,dir=join(root,'artifacts/lookahead-multiband',trial);mkdirSync(dir,{recursive:true});
 const files={};for(const file of readdirSync(consumer).filter(f=>/^candidate-.*\.(wav|f32)$/.test(f)||['lookahead-multiband-results.json','package-lock.json','den.tgz'].includes(f))){copyFileSync(join(consumer,file),join(dir,file));files[file]=hash(join(dir,file));}
 const sources=['src/lookahead-limiter.ts','src/multiband-dynamics.ts','src/dynamics.ts','src/crossover.ts','src/state-variable-filter.ts','src/catalog-filter-math.ts','docs/lookahead-multiband.md','tests/lookahead-multiband.spec.ts','tests/lookahead-multiband-fixture.ts','tests/lookahead-multiband-packed.test.mjs',...['processor.ts','render.mjs','oracle.mjs'].map(f=>`tests/lookahead-multiband-consumer/${f}`),'package.json','package-lock.json'];
 writeFileSync(join(dir,'manifest.json'),JSON.stringify({status:'CANDIDATE',sourceCommit:commit,sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(sources.map(f=>[f,hash(join(root,f))])),packageIntegrity:pack.integrity,publicImports:['@denaudio/den/lookahead-limiter','@denaudio/den/multiband-dynamics'],unworklet:'0.4.1',node:process.version,offlineSampleRates:[44100,48000,96000],browserSampleRates:[],frames:16384,audioFormat:'f32 little-endian planar L then R; WAV stereo',inputAndControls:'Exact deterministic construction in hashed tests/lookahead-multiband-consumer/render.mjs; no random generator, MIDI, assets or presets.',files,verification:'Independent timeline/sliding maximum and exponential release; strict current sample ceiling and delay; direct-form-I LR4 bands and complex APlo×APhi transfer including DC; independent per-band compressor curve; exact snapshots; fixed memory and diagnostic driver costs.',limitations:['Not human approved or golden','No browser/device/true-peak/oversampling claim','No maximum-capacity real-time clearance','Static allpass recombination is not identity PCM or flat moving-cutoff reconstruction']},null,2));
 console.log(`Lookahead/multiband evidence: ${dir}`);
});
