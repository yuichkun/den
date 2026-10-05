import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { renderOffline, encodeWav } from '@unworklet/offline';
import { createInstrument, bassConfig, bassParameters, percussionConfig, percussionParameters, padConfig, padParameters } from '@denaudio/den/instrument';
import { phrases, stress, steal, expand } from './fixtures.mjs';
const settings = { bass:{config:bassConfig,parameters:bassParameters}, percussion:{config:percussionConfig,parameters:percussionParameters}, pad:{config:padConfig,parameters:padParameters} };
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const pcmHash = audio => hash(Buffer.concat(audio.map(channel=>Buffer.from(channel.buffer,channel.byteOffset,channel.byteLength))));
function measure(audio) {
  let peak=0,energy=0,clippedSamples=0,nonfiniteSamples=0;
  for(const value of audio) { if(!Number.isFinite(value))nonfiniteSamples++; peak=Math.max(peak,Math.abs(value));energy+=value*value;if(Math.abs(value)>=1)clippedSamples++; }
  return {frames:audio.length,peak,rms:Math.sqrt(energy/audio.length),headroomDb:peak===0?null:-20*Math.log10(peak),clippedSamples,nonfiniteSamples};
}
function valid(measurement) { assert.equal(measurement.nonfiniteSamples,0);assert.equal(measurement.clippedSamples,0);assert(measurement.peak>0&&measurement.peak<1); }
// The full-scale gate must reject deliberately clipped and nonfinite signals.
assert.throws(()=>valid(measure(Float32Array.of(1.1))));assert.throws(()=>valid(measure(Float32Array.of(NaN))));
function waveform(audio, title) {
  const columns=1200, top=50, bottom=290, middle=170, half=120;
  const points=Array.from({length:columns},(_,i)=>{
    const start=Math.floor(i*audio.length/columns),end=Math.floor((i+1)*audio.length/columns);
    let lo=0,hi=0;for(let n=start;n<end;n++){lo=Math.min(lo,audio[n]);hi=Math.max(hi,audio[n]);}
    return `M${50+i} ${middle-hi*half}V${middle-lo*half}`;
  }).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1300 340"><title>${title}</title><rect width="1300" height="340" fill="white"/><text x="50" y="25">${title}; raw, unnormalized; fixed amplitude ±1</text><path d="M50 ${top}V${bottom}H1250M50 ${middle}H1250" fill="none" stroke="#888"/><text x="15" y="55">+1</text><text x="20" y="175">0</text><text x="15" y="295">−1</text><path d="${points}" stroke="#2850ad" fill="none"/></svg>`;
}
const measurements=[];
for(const [name,setting] of Object.entries(settings)) {
  const processor=createInstrument(setting.config);
  for(const sampleRate of [44100,48000,96000]) {
    for(const [kind,fixture] of Object.entries({phrase:phrases[name],maximum:stress[name],...(name==='pad'?{steal}:{})})) {
      const {frames,midi,windows}=expand(fixture,sampleRate);
      const options={sampleRate,duration:(frames-0.5)/sampleRate,events:midi,params:Object.fromEntries(Object.entries(setting.parameters).map(([key,value])=>[key,[value]]))};
      const result=await renderOffline(processor,options),audio=result.outputs.main;
      assert.equal(audio.length,2);assert.equal(audio[0].length,frames);assert.deepEqual(audio[0],audio[1]);assert.equal(result.diagnostics.scrubbedSamples,0);
      const full=measure(audio[0]);valid(full);
      const finalOff=Math.max(...midi.filter(e=>e.payload.type==='noteOff').map(e=>e.atSample));
      const silenceFrom=finalOff+Math.round(Math.fround(setting.parameters.ampRelease)*sampleRate);
      assert(silenceFrom<frames);assert(audio[0].subarray(silenceFrom).every(x=>x===0));
      const file=`${name}-${kind}-${sampleRate}`,wav=encodeWav(audio,sampleRate);
      writeFileSync(`${file}.wav`,wav);writeFileSync(`${file}.svg`,waveform(audio[0],`CANDIDATE ${name} ${kind}, ${sampleRate} Hz`));
      const record={name,kind,sampleRate,frames,seconds:frames/sampleRate,channels:2,seed:null,status:'CANDIDATE',...setting,midi,silenceFrom,pcmSha256:pcmHash(audio),wavSha256:hash(wav),measurement:full,windows:Object.fromEntries(Object.entries(windows).map(([key,[start,end]])=>[key,{start,end,...measure(audio[0].subarray(start,end))}]))};
      if(kind==='phrase') {
        const repeated=await renderOffline(processor,options);
        assert.equal(repeated.diagnostics.scrubbedSamples,0);assert.equal(pcmHash(repeated.outputs.main),record.pcmSha256);record.repeatedPcmIdentical=true;
      }
      measurements.push(record);console.log(JSON.stringify({name,kind,sampleRate,...full}));
    }
  }
}
writeFileSync('sound-candidates-evidence.json',JSON.stringify({status:'CANDIDATE',runtimeStatus:'NOT_CLEARED',physicalListening:'NOT_APPROVED',normalization:false,fx:null,measurements},null,2));
