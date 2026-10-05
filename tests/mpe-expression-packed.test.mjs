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
test('packed lower-zone expression: public strict types, native MIDI, independent master/member pitch, composed audio and transient snapshots',{timeout:240000},()=>{
  const consumer=mkdtempSync(join(tmpdir(),'den-mpe-expression-'));
  cpSync(join(root,'tests/consumer'),consumer,{recursive:true});cpSync(join(root,'tests/mpe-expression-consumer'),consumer,{recursive:true});
  const [pack]=JSON.parse(run('npm',['pack','--json','--pack-destination',consumer],root));
  for(const extension of ['js','d.ts'])assert(pack.files.some(f=>f.path===`dist/mpe-expression.${extension}`));
  copyFileSync(join(consumer,pack.filename),join(consumer,'den.tgz'));
  const lock=JSON.parse(readFileSync(join(consumer,'package-lock.json'),'utf8'));lock.packages['node_modules/@denaudio/den'].integrity=pack.integrity;
  writeFileSync(join(consumer,'package-lock.json'),JSON.stringify(lock,null,2));
  run('npm',['ci','--include=dev','--ignore-scripts'],consumer);
  assert.deepEqual(JSON.parse(readFileSync(join(consumer,'node_modules/@denaudio/den/package.json'))).exports['./mpe-expression'],{types:'./dist/mpe-expression.d.ts',import:'./dist/mpe-expression.js'});
  writeFileSync(join(consumer,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true,types:[],lib:['ES2023','DOM']},include:['processor.ts']}));
  run('npm',['run','check'],consumer);console.log(run('node',['render.mjs'],consumer));
  const trial=new Date().toISOString().replaceAll(':','-')+'-'+run('git',['rev-parse','--short','HEAD'],root).trim();
  const dir=join(root,'artifacts/mpe-expression',trial);mkdirSync(dir,{recursive:true});
  const files={};for(const file of ['mpe-expression-results.json','package-lock.json','den.tgz']){copyFileSync(join(consumer,file),join(dir,file));files[file]=hash(join(dir,file));}
  const sources=['src/performance.ts','src/voice-policy.ts','src/envelope.ts','src/oscillator.ts','tests/fixtures/performance-reference.ts','src/mpe-expression.ts','docs/mpe-expression.md','tests/mpe-expression.spec.ts','tests/fixtures/mpe-expression-fixture.ts','tests/fixtures/mpe-expression-reference.ts','tests/mpe-expression-packed.test.mjs','tests/mpe-expression-consumer/processor.ts','tests/mpe-expression-consumer/render.mjs','package.json','package-lock.json'];
  writeFileSync(join(dir,'manifest.json'),JSON.stringify({status:'CANDIDATE',sourceCommit:run('git',['rev-parse','HEAD'],root).trim(),sourceDirty:run('git',['status','--porcelain'],root).trim()!=='',sourceHashes:Object.fromEntries(sources.map(f=>[f,hash(join(root,f))])),packageIntegrity:pack.integrity,consumerLockHash:hash(join(consumer,'package-lock.json')),publicSubpath:'@denaudio/den/mpe-expression',unworklet:'0.4.1',node:process.version,offlineSampleRates:[44100,48000,96000],browserSampleRates:[],capacity:{voices:4,heldIdentities:8,memberChannels:15},files,verification:'Independent raw-byte/object expression and native identity model, separate master/member pitch and amplitude oracle, Math.sin/envelope composition oracle, zero scrub, snapshots, public strict TypeScript and fixed memory.',limitations:['Not human approved','Expression-only fixed lower zone; not full MPE', 'No master pedal or zone panic propagation', 'Release tails share current member-channel expression','No browser or hardware real-time evidence','Native MIDI remains quantum-boundary FIFO']},null,2));
  console.log(`MPE expression evidence: ${dir}`);
});
