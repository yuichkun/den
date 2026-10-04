import assert from 'node:assert/strict';
// Estimate period from positive zero crossings, independent of the DSP/LFO code.
// Fit log-frequency to constant + sin/cos at the requested rate; phase is unknown.
export function assertPitchModulation(audio,{sampleRate=48000,carrier=220,rate=4,depth=.5}={}){
 const crossings=[];
 for(let i=1;i<audio.length;i++)if(audio[i-1]<=0&&audio[i]>0)crossings.push(i-1-audio[i-1]/(audio[i]-audio[i-1]));
 assert(crossings.length>100,'insufficient pitched cycles');
 const rows=crossings.slice(1).map((end,i)=>{const start=crossings[i],t=(start+end)/2/sampleRate;return {x:[1,Math.sin(2*Math.PI*rate*t),Math.cos(2*Math.PI*rate*t)],y:12*Math.log2(sampleRate/(end-start)/carrier)};});
 const m=Array.from({length:3},(_,i)=>[...Array.from({length:3},(_,j)=>rows.reduce((s,r)=>s+r.x[i]*r.x[j],0)),rows.reduce((s,r)=>s+r.x[i]*r.y,0)]);
 for(let i=0;i<3;i++){const scale=m[i][i];assert(Math.abs(scale)>1e-9,'singular frequency fit');for(let j=i;j<4;j++)m[i][j]/=scale;for(let k=0;k<3;k++)if(k!==i){const factor=m[k][i];for(let j=i;j<4;j++)m[k][j]-=factor*m[i][j];}}
 const coefficients=m.map(r=>r[3]),amplitude=Math.hypot(coefficients[1],coefficients[2]);
 const residual=Math.max(...rows.map(r=>Math.abs(r.y-r.x.reduce((s,x,i)=>s+x*coefficients[i],0))));
 // Each period averages a small LFO span; at 4 Hz/220 Hz its depth loss is <.001.
 assert(Math.abs(amplitude-depth)<.01,`pitch modulation depth ${amplitude}, expected ${depth}`);
 assert(Math.abs(coefficients[0])<.01,`pitch carrier offset ${coefficients[0]}`);
 assert(residual<.01,`pitch modulation rate/shape residual ${residual}`);
 return {cycles:rows.length,rateHz:rate,depthSemitones:amplitude,carrierOffsetSemitones:coefficients[0],residualSemitones:residual};
}
