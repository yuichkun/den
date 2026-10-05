import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const run=(cmd,args,cwd)=>execFileSync(cmd,cmd==='npm'?['--cache',join(tmpdir(),'den-npm-cache'),...args]:args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
test('packed control modulation public API: locked consumer, capacity bounds, actual DSP and snapshots',{timeout:180000},()=>{
  const consumer=mkdtempSync(join(tmpdir(),'den-control-modulation-'));
  cpSync(join(root,'tests/consumer'),consumer,{recursive:true});
  cpSync(join(root,'tests/control-modulation-consumer'),consumer,{recursive:true});
  const [pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));
  for(const extension of ['js','d.ts'])assert(pack.files.some(f=>f.path===`dist/modulation.${extension}`));
  copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));
  const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));
  lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;
  writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock,null,2));
  run('npm',['ci','--include=dev','--ignore-scripts'],consumer);
  assert.deepEqual(JSON.parse(readFileSync(join(consumer,'node_modules/@denaudio/den/package.json'))).exports['./modulation'],{types:'./dist/modulation.d.ts',import:'./dist/modulation.js'});
  writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,types:[],lib:['ES2023','DOM']},include:['processor.ts']}));
  run('npm',['run','check'],consumer);
  console.log(run('node',['render.mjs'],consumer));
  const trial=new Date().toISOString().replaceAll(':','-')+'-'+run('git',['rev-parse','--short','HEAD'],root).trim();
  const dir=join(root,'artifacts/control-modulation',trial);mkdirSync(dir,{recursive:true});
  const files={};for(const file of ['control-modulation-results.json','package-lock.json','den.tgz']){copyFileSync(join(consumer,file),join(dir,file));files[file]=hash(join(dir,file));}
  writeFileSync(join(dir,'manifest.json'),JSON.stringify({status:'CANDIDATE',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',
    sourceHashes:Object.fromEntries(['src/modulation.ts','docs/control-modulation.md','tests/control-modulation.spec.ts','tests/control-arpeggiator.spec.ts','tests/probes/control-midi-output.mjs','tests/control-modulation-packed.test.mjs','tests/control-modulation-consumer/processor.ts','tests/control-modulation-consumer/render.mjs','package.json','package-lock.json'].map(f=>[f,hash(join(root,f))])),
    packageIntegrity:pack.integrity,consumerLockHash:hash(join(consumer,'package-lock.json')),publicSubpath:'@denaudio/den/modulation',unworklet:'0.4.1',node:process.version,
    offlineSampleRates:[44100,48000,96000],browserSampleRates:[],frames:32768,capacity:{msegSegments:16,sequenceSteps:64},seed:19,files,
    verification:'Independent frequency-unit integral, closed-form MSEG, BigInt PRNG, full snapshots, zero scrub, strict public TypeScript and fixed memory.',
    limitations:['Not human approved','No browser/hardware real-time acceptance','No assertion of indefinite zero numerical drift','No external MIDI host delivery proof']},null,2));
  console.log(`Control modulation evidence: ${dir}`);
});
