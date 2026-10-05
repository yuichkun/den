import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync,copyFileSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const run=(cmd,args,cwd)=>execFileSync(cmd,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:150000});
test('packed performance: public strict types, native MIDI, envelope/oscillator rendering and transient-note snapshots',{timeout:240000},()=>{
  const consumer=mkdtempSync(join(tmpdir(),'den-performance-'));
  cpSync(join(root,'tests/consumer'),consumer,{recursive:true});cpSync(join(root,'tests/performance-consumer'),consumer,{recursive:true});
  const [pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));
  for(const extension of ['js','d.ts'])assert(pack.files.some(f=>f.path===`dist/performance.${extension}`));
  copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));
  const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;
  writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock,null,2));
  run('npm',['ci','--include=dev','--ignore-scripts'],consumer);
  assert.deepEqual(JSON.parse(readFileSync(join(consumer,'node_modules/@denaudio/den/package.json'))).exports['./performance'],{types:'./dist/performance.d.ts',import:'./dist/performance.js'});
  writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,types:[],lib:['ES2023','DOM']},include:['processor.ts']}));
  run('npm',['run','check'],consumer);console.log(run('node',['render.mjs'],consumer));
  const trial=new Date().toISOString().replaceAll(':','-')+'-'+run('git',['rev-parse','--short','HEAD'],root).trim();
  const dir=join(root,'artifacts/performance',trial);mkdirSync(dir,{recursive:true});
  const files={};for(const file of ['performance-results.json','package-lock.json','den.tgz']){copyFileSync(join(consumer,file),join(dir,file));files[file]=hash(join(dir,file));}
  const sources=['src/performance.ts','docs/performance.md','tests/performance-policy.spec.ts','tests/performance-pitch.spec.ts','tests/fixtures/performance-fixture.ts','tests/fixtures/performance-reference.ts','tests/probes/performance-midi-entry.mjs','tests/performance-packed.test.mjs','tests/performance-consumer/processor.ts','tests/performance-consumer/render.mjs','package.json','package-lock.json'];
  writeFileSync(join(dir,'manifest.json'),JSON.stringify({status:'CANDIDATE',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(sources.map(f=>[f,hash(join(root,f))])),packageIntegrity:pack.integrity,consumerLockHash:hash(join(consumer,'package-lock.json')),publicSubpath:'@denaudio/den/performance',unworklet:'0.4.1',node:process.version,offlineSampleRates:[44100,48000,96000],browserSampleRates:[],capacity:{voices:4,heldIdentities:8},files,verification:'Independent FIFO/identity event model, closed-form glide and tuning oracle, Math.sin/envelope composition oracle, zero scrub, snapshots, public strict TypeScript and fixed memory.',limitations:['Not human approved','No MPE policy','No browser or hardware real-time evidence','Native MIDI remains quantum-boundary FIFO','Glide snapshot continuation requires same sample rate']},null,2));
  console.log(`Performance evidence: ${dir}`);
});
