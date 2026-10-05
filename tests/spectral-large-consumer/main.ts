import processor from './processor.ts?worklet';
document.body.textContent = 'CANDIDATE large STFT worklet compiled';
Object.assign(globalThis, { denLargeStftCandidate: processor });
