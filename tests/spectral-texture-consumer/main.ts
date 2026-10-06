import processor from './processor.ts?worklet';
import crossProcessor from './cross-processor.ts?worklet';
document.body.textContent = 'CANDIDATE spectral blur and cross-synthesis worklets compiled';
Object.assign(globalThis, { spectralTextureProcessors: [processor, crossProcessor] });
