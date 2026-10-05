import processor from './processor.ts?worklet';
// Build-only consumer: importing the actual public module must produce native
// worklet/WASM assets. No AudioContext, device request, or audible auto-start.
window.residentRecorderCandidate = processor;
document.querySelector('#status').textContent = 'CANDIDATE native worklet built. Browser execution and realtime behavior are NOT_CLEARED.';
