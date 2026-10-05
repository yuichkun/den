import processor from './processor.ts?worklet';
document.body.textContent = 'CANDIDATE spectral freeze worklet compiled';
Object.assign(globalThis, { denSpectralFreezeCandidate: processor });
