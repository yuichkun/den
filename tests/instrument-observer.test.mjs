import test from 'node:test';
import assert from 'node:assert/strict';
import {CAPTURE_SAMPLES,CAPTURE_BLOCKS,REFERENCE_SCALE,validateInstrumentCapture,sineResidual} from './instrument-observer-contract.mjs';
function valid() {
  return {sampleRate:48000,audio:new Float32Array(CAPTURE_SAMPLES),reference:Float32Array.from({length:CAPTURE_SAMPLES},(_,n)=>(n+1)/REFERENCE_SCALE),capturedSamples:CAPTURE_SAMPLES,capturedBlocks:CAPTURE_BLOCKS,captureErrors:[],referenceSource:{sampleRate:48000,length:CAPTURE_SAMPLES+256,playbackRate:1,detune:0},audioBlockLengths:new Uint16Array(CAPTURE_BLOCKS).fill(128),referenceBlockLengths:new Uint16Array(CAPTURE_BLOCKS).fill(128),sampleOffsets:Uint32Array.from({length:CAPTURE_BLOCKS},(_,n)=>n*128),clockEntries:Float64Array.from({length:CAPTURE_BLOCKS},(_,n)=>n*128),clockExits:Float64Array.from({length:CAPTURE_BLOCKS},(_,n)=>n*128)};
}
test('independent native-ramp contract rejects capture corruption even through silent audio',()=>{
  const clean=valid();assert.equal(validateInstrumentCapture(clean).clockMetadataStatus,'NO_OBSERVED_CLOCK_METADATA_ANOMALY');
  const at=4000*128;
  for(const kind of ['duplicate','drop','reorder','zero','short-audio','short-reference','wrong-total']){
    const c=valid();
    if(kind==='duplicate')c.reference.copyWithin(at,at-128,at);
    if(kind==='drop'){c.reference.copyWithin(at,at+128);c.reference.fill(0,CAPTURE_SAMPLES-128);}
    if(kind==='reorder'){const block=c.reference.slice(at,at+128);c.reference.copyWithin(at,at+128,at+256);c.reference.set(block,at+128);}
    if(kind==='zero')c.reference.fill(0,at,at+128);
    if(kind==='short-audio')c.audioBlockLengths[4000]=127;
    if(kind==='short-reference')c.referenceBlockLengths[4000]=127;
    if(kind==='wrong-total')c.capturedSamples--;
    assert.throws(()=>validateInstrumentCapture(c),undefined,kind);
  }
  // A published-clock defect is still visible and requires review, but cannot
  // outweigh the independently unchanged native reference and audio samples.
  const clock=valid();clock.clockEntries[100]=clock.clockEntries[99];clock.clockExits[100]=clock.clockEntries[100];
  const result=validateInstrumentCapture(clock);assert.equal(result.clockMetadataStatus,'CLOCK_METADATA_ANOMALY_REQUIRES_REVIEW');assert.equal(result.clockAnomalies.length,2);assert.equal(result.runtimeStatus,'NOT_CLEARED');
});
test('full steady-interval PCM prediction detects corruption beyond the old seven-second window',()=>{
  const omega=2*Math.PI*440/48000,cosine=.04,sine=.03,end=8*48000;
  const clean=Float32Array.from({length:end},(_,n)=>cosine*Math.cos(omega*n)+sine*Math.sin(omega*n));
  assert(sineResidual(clean,cosine,sine,omega,0,end)<2e-5);
  const at=Math.floor(7.5*48000/128)*128;
  for(const kind of ['duplicate','drop','reorder','zero']){
    const audio=clean.slice();
    if(kind==='duplicate')audio.copyWithin(at,at-128,at);
    if(kind==='drop')audio.copyWithin(at,at+128,at+256);
    if(kind==='reorder'){const block=audio.slice(at,at+128);audio.copyWithin(at,at+128,at+256);audio.set(block,at+128);}
    if(kind==='zero')audio.fill(0,at,at+128);
    assert(sineResidual(audio,cosine,sine,omega,0,7*48000)<2e-5,`${kind} is deliberately outside the former window`);
    assert(sineResidual(audio,cosine,sine,omega,0,end)>2e-5,`${kind} cannot pass the full window`);
  }
});
