import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { renderOffline, encodeWav } from '@unworklet/offline';
import processor from './processor.ts';
const records=[];
function coefficients(rate,frequency,q,kind,db=0){const w=2*Math.PI*frequency/rate,c=Math.cos(w),a=Math.sin(w)/(2*q),A=10**(db/40);let b,den;
 if(kind==='low'){b=[(1-c)/2,1-c,(1-c)/2];den=[1+a,-2*c,1-a];}
 else if(kind==='high'){b=[(1+c)/2,-1-c,(1+c)/2];den=[1+a,-2*c,1-a];}
 else if(kind==='band'){b=[a,0,-a];den=[1+a,-2*c,1-a];}
 else{b=[1+a*A,-2*c,1-a*A];den=[1+a/A,-2*c,1-a/A];}
 return {b:b.map(x=>x/den[0]),a:den.map(x=>x/den[0])};}
function direct(input,c){let x1=0,x2=0,y1=0,y2=0;return Float64Array.from(input,x=>{const y=c.b[0]*x+c.b[1]*x1+c.b[2]*x2-c.a[1]*y1-c.a[2]*y2;x2=x1;x1=x;y2=y1;y1=y;return y;});}
for(const sampleRate of [44100,48000,96000]){
 const frames=8192,input=new Float32Array(frames);input[0]=.1;
 const options={sampleRate,duration:(frames-.5)/sampleRate,inputs:{main:[input]},params:{cutoff:[1000],gain:[12],reset:[0]}};
 const result=await renderOffline(processor,options),audio=result.outputs.main;
 assert.equal(result.diagnostics.scrubbedSamples,0);assert.equal(audio.length,5);assert(audio.every(x=>x.length===frames));
 const lp=coefficients(sampleRate,1000,Math.fround(Math.SQRT1_2),'low'),hp=coefficients(sampleRate,1000,Math.fround(Math.SQRT1_2),'high');
 const formantA=direct(input,coefficients(sampleRate,500,4,'band')),formantB=direct(input,coefficients(sampleRate,1500,8,'band'));
 const expected=[direct(input,lp),direct(input,coefficients(sampleRate,1000,2,'peak',12)),direct(Float32Array.from(direct(input,lp)),lp),direct(Float32Array.from(direct(input,hp)),hp),Float64Array.from(input,(_,i)=>.5*formantA[i]+.25*formantB[i])];
 const measurement=audio.map((channel,ch)=>{let error=0,peak=0;for(let n=0;n<frames;n++){assert(Number.isFinite(channel[n]));error=Math.max(error,Math.abs(channel[n]-expected[ch][n]));peak=Math.max(peak,Math.abs(channel[n]));}assert(error<1e-5);assert(peak<1);return {channel:ch,error,peak};});
 const pcm=Buffer.concat(audio.map(x=>Buffer.from(x.buffer))),repeat=await renderOffline(processor,options);assert.equal(repeat.diagnostics.scrubbedSamples,0);assert(Buffer.concat(repeat.outputs.main.map(x=>Buffer.from(x.buffer))).equals(pcm));
 const wav=encodeWav(audio,sampleRate),basename=`catalog-filters-${sampleRate}`;writeFileSync(basename+'.wav',wav);writeFileSync(basename+'.f32',pcm);
 const lines=audio.map((channel,ch)=>{const points=Array.from({length:512},(_,i)=>`${40+i*2},${65+ch*100-channel[i]*40}`).join(' ');return `<text x="40" y="${35+ch*100}">${['SVF lowpass','Peaking EQ +12 dB','LR4 low','LR4 high','Formant bank'][ch]} · scale ±1</text><polyline points="${points}" fill="none" stroke="#3c6398"/>`;}).join('');
 writeFileSync(basename+'.svg',`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 520"><title>CANDIDATE catalog filter impulse at ${sampleRate} Hz</title>${lines}</svg>`);
 records.push({sampleRate,frames,channels:5,input:{kind:'impulse',amplitude:Math.fround(.1),sample:0},parameters:{cutoff:1000,gain:12,reset:0},midi:[],seed:null,pcmSha256:createHash('sha256').update(pcm).digest('hex'),wavSha256:createHash('sha256').update(wav).digest('hex'),measurement,repeatedPcmIdentical:true});
}
writeFileSync('catalog-filters-evidence.json',JSON.stringify({status:'CANDIDATE',runtimeStatus:'NOT_CLEARED',normalization:false,records},null,2));
