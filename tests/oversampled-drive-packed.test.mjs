import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const run=(command,args,cwd)=>execFileSync(command,args,{cwd,encoding:'utf8',timeout:180000,env:{...process.env,npm_config_cache:process.env.npm_config_cache??join(tmpdir(),'den-npm-cache')}});
test('packed 2x/4x oversampled drive: strict public types, independent literal FIRs, native controls/state and candidate costs',{timeout:240000},()=>{
  const consumer=mkdtempSync(join(tmpdir(),'den-oversampled-drive-'));
  for(const file of ['package.json','package-lock.json'])copyFileSync(join(root,'tests/consumer',file),join(consumer,file));
  cpSync(join(root,'tests/oversampled-drive-consumer'),consumer,{recursive:true});
  writeFileSync(join(consumer,'reference.ts'),readFileSync(join(root,'tests/fixtures/oversampled-drive-reference.ts'),'utf8').replace('../../src/drive.js','@denaudio/den/drive').replace('./drive-reference.js','./drive-reference.ts'));
  writeFileSync(join(consumer,'drive-reference.ts'),readFileSync(join(root,'tests/fixtures/drive-reference.ts'),'utf8').replace('../../src/drive.js','@denaudio/den/drive'));
  const[pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));
  for(const extension of ['js','d.ts'])assert(pack.files.some(file=>file.path===`dist/oversampled-drive.${extension}`));
  copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));
  const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock,null,2));
  run('npm',['ci','--include=dev','--ignore-scripts'],consumer);
  const installed=JSON.parse(readFileSync(join(consumer,'node_modules/@denaudio/den/package.json'),'utf8'));
  assert.deepEqual(installed.exports['./oversampled-drive'],{types:'./dist/oversampled-drive.d.ts',import:'./dist/oversampled-drive.js'});
  run('node',['node_modules/typescript/bin/tsc','--noEmit','--strict','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','processor.ts'],consumer);
  console.log(run('node',['render.ts'],consumer));
  const trial=`${new Date().toISOString().replaceAll(':','-')}-${run('git',['rev-parse','--short','HEAD'],root).trim()}`,output=join(root,'artifacts/oversampled-drive',trial);mkdirSync(output,{recursive:true});
  const files={};for(const file of readdirSync(consumer).filter(file=>file.startsWith('candidate-')||['oversampled-drive-results.json','package-lock.json','den.tgz'].includes(file))){copyFileSync(join(consumer,file),join(output,file));files[file]=hash(join(output,file));}
  const sources=['src/oversampled-drive.ts','docs/oversampled-drive.md','tests/oversampled-drive.spec.ts','tests/fixtures/oversampled-drive-reference.ts','tests/fixtures/drive-reference.ts','tests/probes/oversampled-drive-cost.mjs','tests/oversampled-drive-packed.test.mjs','tests/oversampled-drive-consumer/processor.ts','tests/oversampled-drive-consumer/render.ts','package.json','package-lock.json'];
  writeFileSync(join(output,'manifest.json'),JSON.stringify({status:'CANDIDATE',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(sources.map(file=>[file,hash(join(root,file))])),packageIntegrity:pack.integrity,consumerLockSha256:hash(join(consumer,'package-lock.json')),unworklet:'0.4.1',node:process.version,publicSubpaths:['/oversampled-drive'],offlineSampleRates:[44100,48000,96000],browserSampleRates:[],frames:8192,files,
    verification:'Strict isolated public types, native gain/mix edits, literal zero-stuff/high-rate double convolution oracle, exact same-schema snapshots, reset/tail and fixed memory',
    limitations:['Not human approved','Fixed memoryless curves only; no arbitrary-graph oversampling','32-sample bulk delay has causal precursors','Dry bypass is filtered/delayed','Finite filter and internal-rate alias residual remain','No browser/realtime deadline evidence']},null,2));
  console.log(`Oversampled drive evidence: ${output}`);
});
