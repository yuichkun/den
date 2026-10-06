// Retained entry probe for the existing clock's negative-tiny seek boundary.
// Run only with an allocated native-work lease; all files are local CANDIDATE.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { audioInput, audioOutput, bool, defineProcessor, f32, forSample, instantiate, inspect } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { musicalClock } from '../../src/modulation.ts';
const destination=resolve(process.argv[2]??'/tmp/den-musical-clock-boundary');
mkdirSync(destination,{recursive:true});
const configs=[1,3,64].flatMap((steps,n)=>[
  {sampleRate:48000,mode:'free',steps},
  {sampleRate:48000,mode:'tempo',steps,stepsPerBeat:[64,1,1/64][n]},
]);
const positions=[-(2**-149),-(2**-60),-(2**-24),0,2**-149,2**-60,
  -1-2**-23,-1,-1+2**-24,-3-2**-22,-3,-3+2**-22,
  -64-2**-17,-64,-64+2**-18,1-(2**-24),1,1+2**-23,
  -1048576,1048576,-(2**-60)];
const frames=positions.length*128;
const controls=[Float32Array.from({length:frames},(_,n)=>positions[Math.floor(n/128)]),
  Float32Array.from({length:frames},(_,n)=>Number(n%128===127))];
const processor=defineProcessor(()=>{
  const input=audioInput({channels:2,name:'control'}),output=audioOutput({channels:configs.length*2+2,name:'main'});
  const units=configs.map((c,n)=>instantiate(musicalClock,c,{name:`clock${n}`}));
  return{process(){forSample(i=>{
    units.forEach((unit,n)=>{
      const r=unit.tick({rate:f32(0),reset:bool(false),seek:input.ch(1).at(i).gt(0),position:input.ch(0).at(i)});
      output.ch(n*2).at(i).write(r.step);output.ch(n*2+1).at(i).write(r.phase);
    });
    const x=input.ch(0).at(i),wrapped=x.sub(x.floor());
    output.ch(configs.length*2).at(i).write(wrapped);
    output.ch(configs.length*2+1).at(i).write(wrapped.clamp(0,1-(2**-24)));
  });}};
});
const result=await renderOffline(processor,{sampleRate:48000,duration:(frames-.25)/48000,inputs:{control:controls}});
assert.equal(result.diagnostics.scrubbedSamples,0);
const source=readFileSync(new URL('../../src/modulation.ts',import.meta.url));
writeFileSync(join(destination,'original-modulation.ts'),source);
writeFileSync(join(destination,'controls.f32'),Buffer.concat(controls.map(c=>Buffer.from(c.buffer))));
writeFileSync(join(destination,'outputs.f32'),Buffer.concat(result.outputs.main.map(c=>Buffer.from(c.buffer))));
writeFileSync(join(destination,'state.bin'),result.state);
const report={status:'CANDIDATE',runtime:'NOT_CLEARED',sourceSHA256:createHash('sha256').update(source).digest('hex'),configs,
  cases:positions.map((position,n)=>({position:Math.fround(position),sample:n*128+127,
    clock:configs.map((c,k)=>({...c,step:result.outputs.main[k*2][n*128+127],phase:result.outputs.main[k*2+1][n*128+127]})),
    directF32Wrap:result.outputs.main[configs.length*2][n*128+127],cappedF32Wrap:result.outputs.main[configs.length*2+1][n*128+127]})),
  snapshot:inspect(result.state),scrubbedSamples:result.diagnostics.scrubbedSamples};
writeFileSync(join(destination,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({destination,sourceSHA256:report.sourceSHA256,first:report.cases[0],last:report.cases.at(-1),snapshot:report.snapshot}));
