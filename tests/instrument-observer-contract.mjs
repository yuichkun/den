import assert from 'node:assert/strict';

// This is one fixture's observation contract, not a DSP or clock runtime.
export const CAPTURE_SAMPLES = 576000;
export const CAPTURE_BLOCKS = 4500;
export const REFERENCE_SCALE = 2 ** 20;
export function validateInstrumentCapture(capture) {
  assert.equal(capture.sampleRate, 48000);
  assert.equal(capture.audio.length, CAPTURE_SAMPLES);
  assert.equal(capture.reference.length, CAPTURE_SAMPLES);
  assert.equal(capture.capturedSamples, CAPTURE_SAMPLES);
  assert.equal(capture.capturedBlocks, CAPTURE_BLOCKS);
  assert.deepEqual(capture.captureErrors, []);
  assert.equal(capture.referenceSource.sampleRate, 48000);
  assert.equal(capture.referenceSource.length, CAPTURE_SAMPLES + 256);
  assert.equal(capture.referenceSource.playbackRate, 1);
  assert.equal(capture.referenceSource.detune, 0);
  for (const key of ['audioBlockLengths', 'referenceBlockLengths', 'sampleOffsets', 'clockEntries', 'clockExits']) assert.equal(capture[key].length, CAPTURE_BLOCKS, key);
  const first = capture.reference[0] * REFERENCE_SCALE;
  assert(Number.isInteger(first) && first >= 1 && first <= 128, 'native ramp starts in its first complete quantum');
  const clockAnomalies = [];
  for (let block = 0; block < CAPTURE_BLOCKS; block++) {
    assert.equal(capture.audioBlockLengths[block], 128, `instrument block length ${block}`);
    assert.equal(capture.referenceBlockLengths[block], 128, `reference block length ${block}`);
    assert.equal(capture.sampleOffsets[block], block * 128, `capture offset ${block}`);
    const entry = capture.clockEntries[block], exit = capture.clockExits[block];
    assert(Number.isSafeInteger(entry) && entry >= 0 && Number.isSafeInteger(exit) && exit >= 0, 'recorded currentFrame metadata');
    if (entry !== exit) clockAnomalies.push({block, kind:'changed-during-callback', entry, exit});
    if (block && entry !== capture.clockEntries[block - 1] + 128) clockAnomalies.push({block, kind:'entry-step', previous:capture.clockEntries[block - 1], current:entry});
  }
  for (let n = 0; n < CAPTURE_SAMPLES; n++) {
    assert(Number.isFinite(capture.audio[n]), `finite instrument sample ${n}`);
    assert.equal(capture.reference[n] * REFERENCE_SCALE, first + n, `native reference sample ${n}`);
  }
  return {frames:CAPTURE_SAMPLES,blocks:CAPTURE_BLOCKS,firstReferenceInteger:first,lastReferenceInteger:first+CAPTURE_SAMPLES-1,
    referenceProgression:'EXACT_NATIVE_BUFFER_SOURCE',clockMetadataStatus:clockAnomalies.length?'CLOCK_METADATA_ANOMALY_REQUIRES_REVIEW':'NO_OBSERVED_CLOCK_METADATA_ANOMALY',clockAnomalies,runtimeStatus:'NOT_CLEARED'};
}

export function sineResidual(audio, cosine, sine, omega, from, to) {
  let maximum = 0;
  for (let n = from; n < to; n++) maximum = Math.max(maximum, Math.abs(audio[n] - cosine * Math.cos(omega*n) - sine * Math.sin(omega*n)));
  return maximum;
}
