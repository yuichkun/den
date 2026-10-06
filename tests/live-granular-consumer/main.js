import processor from './processor.ts?worklet';
window.liveGranularCandidate = processor;
document.querySelector('#status').textContent = 'CANDIDATE native worklet built. Browser execution and realtime behavior are NOT_CLEARED.';
