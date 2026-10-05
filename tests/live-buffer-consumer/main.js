import processor from './processor.ts?worklet';
// Build-only consumer. No AudioContext/device request or automatic playback.
window.liveBufferCandidate = processor;
document.querySelector('#status').textContent = 'CANDIDATE native worklet built. Browser execution and realtime behavior are NOT_CLEARED.';
