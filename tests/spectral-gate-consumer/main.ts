import processor from './processor.ts?worklet';
document.body.textContent = 'CANDIDATE spectral gate worklet compiled';
Object.assign(globalThis, { denSpectralGateCandidate: processor });
