import hybrid from './processor.ts?worklet';
import pitched from './pitched-processor.ts?worklet';
document.body.textContent = 'CANDIDATE hybrid space and feedforward pitched-tail worklets compiled';
Object.assign(globalThis, { spatialChainProcessors: [hybrid, pitched] });
