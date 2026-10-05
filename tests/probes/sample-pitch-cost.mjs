// Minimal public-API compilation diagnostic; no expected-audio changes.
import {performance} from 'node:perf_hooks';
import {audioInput,audioOutput,compile,defineProcessor,f32,f64,forSample,i32,select,state} from '@unworklet/core';
function exact(exponent){
 const whole=exponent.floor(),x=exponent.sub(whole).mul(Math.LN2);let factorial=1;const coefficients=[1];
 for(let n=1;n<=12;n++){factorial*=n;coefficients.push(1/factorial);}
 let polynomial=f64(coefficients[12]);for(let n=11;n>=0;n--)polynomial=polynomial.mul(x).add(coefficients[n]);
 const index=i32(whole.add(13));let scale=f64(2**-13);
 for(let bit=0;bit<5;bit++)scale=scale.mul(select(index.div(2**bit).mod(2).eq(1),f64(2**(2**bit)),f64(1)));
 return polynomial.mul(scale);
}
for(const mode of ['native-pow','exact-polynomial']){
 const begin=performance.now();const p=defineProcessor(()=>{
  const input=audioInput({channels:1,name:'key'}),out=audioOutput({channels:1,name:'main'});
  return{process(){forSample(i=>{const exponent=f64(input.ch(0).at(i)).clamp(0,127).sub(60).div(12);out.ch(0).at(i).write(f32(mode==='native-pow'?f64(2).pow(exponent):exact(exponent)));});}};
 });const captureMs=performance.now()-begin,astBytes=JSON.stringify(p.graph).length,start=performance.now();const compiled=await compile(p,{sampleRate:48000});
 console.log(JSON.stringify({mode,captureMs,astBytes,compileMs:performance.now()-start,wasmBytes:compiled.wasm.byteLength}));
}
