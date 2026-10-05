import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync,copyFileSync,mkdtempSync,readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),frames=4096;
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const run=(cmd,args,cwd)=>execFileSync(cmd,cmd==='npm'?['--cache',join(tmpdir(),'den-npm-cache'),...args]:args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});

test('packed sample catalog: strict public types, independent PCM/grain renders, snapshots and bounded allocation',{timeout:180000},()=>{
 const consumer=mkdtempSync(join(tmpdir(),'den-samples-'));
 cpSync(join(root,'tests/consumer'),consumer,{recursive:true});cpSync(join(root,'tests/sample-consumer'),consumer,{recursive:true});
 copyFileSync(join(root,'tests/fixtures/sample-reference.ts'),join(consumer,'sample-reference.ts'));
 const [pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));
 for(const extension of ['js','d.ts'])assert(pack.files.some(file=>file.path===`dist/sample.${extension}`));
 copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));
 const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock,null,2));
 run('npm',['ci','--include=dev','--ignore-scripts'],consumer);
 const installed=JSON.parse(readFileSync(join(consumer,'node_modules/@denaudio/den/package.json'),'utf8'));assert.deepEqual(installed.exports['./sample'],{types:'./dist/sample.d.ts',import:'./dist/sample.js'});
 writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,types:[],lib:['ES2023','DOM']},include:['processor.ts','sample-reference.ts']}));
 run('npm',['run','check'],consumer);console.log(run('node',['render.mjs'],consumer));
 const profiles=[];
 // Separate child processes keep each module's timing/memory attribution isolated.
 for(const [kind,count] of [['resident',1],['player',1],['zones',1],['zones',16],['grains',1],['grains',4],['grains',32],['combined',4]]) profiles.push(JSON.parse(run('node',['profile.mjs',kind,String(count)],consumer)));
 const reportPath=join(consumer,'sample-results.json'),report=JSON.parse(readFileSync(reportPath,'utf8'));report.profiles=profiles;writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({profiles}));
 const trial=`${new Date().toISOString().replaceAll(':','-')}-${run('git',['rev-parse','--short','HEAD'],root).trim()}`,dir=join(root,'artifacts/samples',trial);mkdirSync(dir,{recursive:true});
 const files={};
 for(const file of readdirSync(consumer).filter(file=>/^candidate-.*\.wav$/.test(file)||['sample-results.json','package-lock.json','den.tgz'].includes(file))){copyFileSync(join(consumer,file),join(dir,file));files[file]=hash(join(dir,file));}
 const sources=['src/sample.ts','docs/sample.md','tests/sample.spec.ts','tests/fixtures/sample-reference.ts','tests/probes/sample-ingress.mjs','tests/sample-packed.test.mjs','tests/sample-consumer/processor.ts','tests/sample-consumer/render.mjs','tests/sample-consumer/profile.mjs','package.json','package-lock.json'];
 writeFileSync(join(dir,'manifest.json'),JSON.stringify({status:'CANDIDATE',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(sources.map(file=>[file,hash(join(root,file))])),packageIntegrity:pack.integrity,consumerLockHash:hash(join(consumer,'package-lock.json')),unworklet:'0.4.1',node:process.version,publicSubpaths:['/sample'],offlineSampleRates:[44100,48000,96000],browserSampleRates:[],frames,settings:{resident:{sourceRate:32000,capacity:1024,channels:1,ingressSlots:16},loop:{start:3,end:997,rate:.75,releaseFrames:32},reverse:{start:3,end:997,rate:-1.25},multisample:{zones:16,key:72,rootKey:60,velocity:.75},granular:{maxGrains:32,seed:174,positionFrames:500,jitterFrames:250,rate:-.75,durationSeconds:.05,densityHz:2000}},excitation:'Original synthetic sine plus ramp PCM; native Float32Array event at quantum zero',reset:false,seed:174,midi:[],preset:null,files,verification:'Independent scalar interpolation and phase arithmetic, first-match pitch/velocity mapping, seeded triangular grain pool, active maximum saturation/drop, exact same-schema continuation, strict public TypeScript, separate unloaded-driver fixed memory diagnostic',limitations:['Not human approved','No browser/device/host or realtime evidence','Linear interpolation aliases; no seamless-loop/crossfade promise','Loader/streaming/live-buffer/spectral work remains outside this candidate','Native loading copies at process dispatch; preload before audible use','Unused PCM tails remain in snapshots; unload is not secure erasure']},null,2));
 console.log(`Sample evidence: ${dir}`);
});
