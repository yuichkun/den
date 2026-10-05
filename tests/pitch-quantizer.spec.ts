import { expect, test as baseTest } from 'vitest';
import { audioInput, audioOutput, compile, defineProcessor, f32, forSample, instantiate } from '@unworklet/core';
import { renderOffline } from '@unworklet/offline';
import { pitchQuantizer, type PitchQuantizerConfig } from '../src/pitch-quantizer.js';
const test = (name: string, fn: () => unknown) => baseTest(name, fn, 30000);
const rates = [44100, 48000, 96000];
const classes = (c: PitchQuantizerConfig) => c.pitchClasses.map(x => Math.fround(x) || 0).sort((a,b)=>a-b);
const sanitize = (v: number) => Number.isNaN(v) ? 0 : Math.max(-16384, Math.min(16384, Math.fround(v)));
function processor(configs: PitchQuantizerConfig[]) {
  return defineProcessor(() => {
    const input = audioInput({ channels: 2, name: 'control' });
    const output = audioOutput({ channels: configs.length * 3, name: 'main' });
    const units = configs.map((c,n)=>instantiate(pitchQuantizer,c,{name:`quantizer${n}`}));
    return { process() { forSample(i=>{
      units.forEach((unit,n)=>{
        const q=unit.tick(input.ch(0).at(i),input.ch(1).at(i).gt(0));
        [q.pitch,f32(q.degree),f32(q.octave)].forEach((value,k)=>output.ch(n*3+k).at(i).write(value));
      });
    }); } };
  });
}
const render = (p: ReturnType<typeof processor>, rate: number, rows: number[][], restore?: Uint8Array) => renderOffline(p, {
  sampleRate: rate, duration: (rows.length - 0.25) / rate,
  inputs: { control: [Float32Array.from(rows,r=>r[0]),Float32Array.from(rows,r=>r[1])] }, restore,
});
// Independent exhaustive local lattice: no implementation's per-class octave
// calculation. Ordered pitch/distance comparisons define the f64 contract.
function nearest(x: number, ds: number[]) {
  const center = Math.floor(x / 12);
  let best = { pitch: Infinity, distance: Infinity, degree: 0, octave: 0 };
  for (let octave=center-2;octave<=center+2;octave++) for(let degree=0;degree<ds.length;degree++) {
    const pitch=octave*12+ds[degree],distance=Math.abs(x-pitch);
    if(distance<best.distance || distance===best.distance && (pitch<best.pitch || pitch===best.pitch&&degree<best.degree)) best={pitch,distance,degree,octave};
  }
  return best;
}
function reference(rows: number[][], config: PitchQuantizerConfig) {
  const ds=classes(config),h=Math.fround(config.hysteresis??0);
  let old: ReturnType<typeof nearest> | undefined;
  return rows.map(([value,reset])=>{
    const x=sanitize(value),candidate=nearest(x,ds);
    let retain=false;
    if(old&&h>0&&!reset) {
      const i=old.degree,base=old.octave*12;
      const prev=i===0?ds[ds.length-1]-12:ds[i-1],next=i===ds.length-1?ds[0]+12:ds[i+1];
      retain=x>=base+((prev+ds[i])/2-h)&&x<=base+((ds[i]+next)/2+h);
    }
    old=retain?old!:candidate;
    return [Math.fround(old.octave*12+ds[old.degree]),old.degree,old.octave];
  });
}
function check(r: Awaited<ReturnType<typeof render>>, rows: number[][], configs: PitchQuantizerConfig[]) {
  configs.forEach((config,unit)=>reference(rows,config).forEach((expected,n)=>expected.forEach((v,k)=>{
    expect(r.outputs.main[unit*3+k][n],`unit ${unit} channel ${k} frame ${n}, input ${rows[n]}`).toBe(v);
  })));
  expect(r.diagnostics.scrubbedSamples).toBe(0);
}
function nextFloat(value: number, direction: number) {
  if(value===0)return direction>0?2**-149:-(2**-149);
  const a=new Float32Array([value]),bits=new Uint32Array(a.buffer);
  bits[0]+=Math.sign(value)===Math.sign(direction)?1:-1;
  return a[0];
}
function boundaryRows(ds: number[]) {
  const values=[-1e30,1e30,-16384,16384,NaN,Infinity,-Infinity,0,-0,2**-149,-(2**-149)];
  for(const octave of [-1366,-11,-2,-1,0,1,5,10,1365]) for(let i=0;i<ds.length;i++) {
    const lo=octave*12+ds[i],hi=i===ds.length-1?(octave+1)*12+ds[0]:octave*12+ds[i+1];
    const mid=Math.fround((lo+hi)/2);
    values.push(lo,hi,nextFloat(mid,-1),mid,nextFloat(mid,1));
  }
  for(let i=0;i<600;i++) values.push(-80+i*0.3125);
  return values.map(x=>[x,0]);
}
for(const rate of rates) {
  test(`native nearest, signed octave midpoints, nonfinite/extreme controls at ${rate}`,async()=>{
    const configs=[{pitchClasses:[11,7,0,5,2,9,4]},{pitchClasses:[6]},{pitchClasses:[0.125,1.375,3.75,7.25,11.875]}];
    const rows=boundaryRows([0,2,4,5,7,9,11]).concat(boundaryRows([0.125,1.375,3.75,7.25,11.875]));
    const p=processor(configs),r=await render(p,rate,rows);check(r,rows,configs);
    expect(r.outputs.main[3][3]).toBe(16386); // Clamped input, scale output may exceed it.
  });
  test(`hysteresis boundary equality, trajectories, reset and native snapshots at ${rate}`,async()=>{
    const configs=[{pitchClasses:[0,2,5,7,11],hysteresis:0.25},{pitchClasses:[0,2,5,7,11],hysteresis:0},{pitchClasses:[0],hysteresis:12}];
    const trajectory=[0,1,1.25,nextFloat(1.25,1),1,0.75,nextFloat(0.75,-1),-0.75,-0.5,-0.75,nextFloat(-0.75,-1),11,11.5,11.75,nextFloat(11.75,1),12,25,-25,6,-6];
    const rows=Array.from({length:1024},(_,n)=>[trajectory[n%trajectory.length],n>=125&&n<=131||n>=255&&n<=258||n===512?1:0]);
    const p=processor(configs),r=await render(p,rate,rows);check(r,rows,configs);
    expect(Array.from(r.outputs.main[0].slice(0,7))).toEqual([0,0,0,2,2,2,0]);
    const first=await render(p,rate,rows.slice(0,256)),resumed=await render(p,rate,rows.slice(256),first.state);
    r.outputs.main.forEach((v,ch)=>expect(resumed.outputs.main[ch]).toEqual(v.slice(256)));
    // Holding reset high re-evaluates every input rather than pinning a note.
    for(let n=125;n<=131;n++)expect(r.outputs.main[0][n]).toBe(r.outputs.main[3][n]);
  });
}
test('microtonal state preserves degree when f32 output pitches collapse, and tiny classes survive state',async()=>{
  const tiny=2**-149,configs=[{pitchClasses:[tiny,0,0.001,2.375,11.75],hysteresis:0.125},{pitchClasses:[tiny,0],hysteresis:0},{pitchClasses:[0,0.0001,2.375,11.75],hysteresis:0}];
  const values=[0,tiny,-tiny,0.0005,0.001,12,12.001,-12,-11.999,16380,nextFloat(16380,1),-16380,nextFloat(-16380,1),2.375,-9.625,11.75,-0.25];
  const rows=Array.from({length:512},(_,n)=>[values[n%values.length],n%17===0?1:0]);
  const p=processor(configs),r=await render(p,48000,rows);check(r,rows,configs);
  expect(r.outputs.main[3][1]).toBe(tiny);expect(r.outputs.main[4][1]).toBe(1);
  expect(r.outputs.main[6][9]).toBe(16380);expect(r.outputs.main[6][10]).toBe(16380);
  expect(r.outputs.main[7][9]).toBe(0);expect(r.outputs.main[7][10]).toBe(1);
  const first=await render(p,48000,rows.slice(0,256)),last=await render(p,48000,rows.slice(256),first.state);
  r.outputs.main.forEach((v,ch)=>expect(last.outputs.main[ch]).toEqual(v.slice(256)));
});
test('maximum scale capacity renders bounded native graph and independent exhaustive nearest',async()=>{
  const configs=[{pitchClasses:Array.from({length:128},(_,i)=>i*12/128),hysteresis:0.03125}];
  const rows=Array.from({length:512},(_,i)=>[Math.fround(-128+i*0.503),i%127===0?1:0]);
  check(await render(processor(configs),48000,rows),rows,configs);
});
test('construction rejects nonfinite, bounds, capacity, and duplicates after f32 canonicalization',async()=>{
  for(const pitchClasses of [[],new Array<number>(1),[0,,] as number[],new Array<number>(128),Array(129).fill(0),[-1],[12],[NaN],[Infinity],[0,0],[0,-0],[1,1+2**-25],[12-2**-30]]) {
    await expect((async()=>compile(processor([{pitchClasses}])))()).rejects.toThrow(RangeError);
  }
  for(const hysteresis of [-1,12.01,NaN,Infinity])await expect((async()=>compile(processor([{pitchClasses:[0],hysteresis}])))()).rejects.toThrow(RangeError);
});
