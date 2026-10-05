import processor from './processor.ts?worklet';
document.body.textContent = 'CANDIDATE spectral worklet compiled';
Object.assign(globalThis, { denSpectralCandidate: processor });
