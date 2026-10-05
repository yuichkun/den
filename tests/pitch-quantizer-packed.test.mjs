import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const run=(cmd,args,cwd)=>execFileSync(cmd,cmd==='npm'?['--cache',process.env.npm_config_cache??join(tmpdir(),'den-npm-cache'),...args]:args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:150000});
test('packed pitch quantizer: public declarations, native nearest/hysteresis and snapshots',{timeout:180000},()=>{
  const consumer=mkdtempSync(join(tmpdir(),'den-pitch-quantizer-'));
  try {
    cpSync(join(root,'tests/consumer'),consumer,{recursive:true});
    cpSync(join(root,'tests/pitch-quantizer-consumer'),consumer,{recursive:true});
    const [pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));
    for(const extension of ['js','d.ts'])assert(pack.files.some(f=>f.path===`dist/pitch-quantizer.${extension}`));
    copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));
    const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));
    lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;
    writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock,null,2));
    run('npm',['ci','--include=dev','--ignore-scripts'],consumer);
    assert.deepEqual(JSON.parse(readFileSync(join(consumer,'node_modules/@denaudio/den/package.json'))).exports['./pitch-quantizer'],{types:'./dist/pitch-quantizer.d.ts',import:'./dist/pitch-quantizer.js'});
    writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,types:[],lib:['ES2023','DOM']},include:['processor.ts']}));
    run('npm',['run','check'],consumer);
    console.log(run('node',['render.mjs'],consumer));
    const trial=new Date().toISOString().replaceAll(':','-')+'-'+run('git',['rev-parse','--short','HEAD'],root).trim();
    const dir=join(root,'artifacts/pitch-quantizer',trial);mkdirSync(dir,{recursive:true});
    const files={};for(const file of ['pitch-quantizer-results.json','package-lock.json','den.tgz']){copyFileSync(join(consumer,file),join(dir,file));files[file]=hash(join(dir,file));}
    writeFileSync(join(dir,'manifest.json'),JSON.stringify({status:'CANDIDATE',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',
      sourceHashes:Object.fromEntries(['src/pitch-quantizer.ts','docs/pitch-quantizer.md','tests/pitch-quantizer.spec.ts','tests/pitch-quantizer-packed.test.mjs','tests/pitch-quantizer-consumer/processor.ts','tests/pitch-quantizer-consumer/render.mjs','package.json','package-lock.json'].map(f=>[f,hash(join(root,f))])),
      packageIntegrity:pack.integrity,consumerLockHash:hash(join(consumer,'package-lock.json')),publicSubpath:'@denaudio/den/pitch-quantizer',unworklet:'0.4.1',node:process.version,
      offlineSampleRates:[44100,48000,96000],browserSampleRates:[],frames:8192,capacity:{pitchClasses:128},files,
      verification:'Exhaustive local scale lattice, exact native f64 computational ties, Schmitt/reset trajectories, public TypeScript, bit-exact snapshot continuation, zero scrub, fixed native memory.',
      limitations:['Not human approved','No browser/hardware real-time acceptance','No arbitrary-precision microtonal distinguishability claim','No audio pitch detection or external MIDI host delivery']},null,2));
    console.log(`Pitch quantizer evidence: ${dir}`);
  } finally {
    // This test owns the isolated temporary consumer. Evidence was copied out;
    // do not accumulate another dependency tree in a constrained CI workspace.
    rmSync(consumer,{recursive:true,force:true});
  }
});
