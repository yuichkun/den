import processor from './processor.ts?worklet';
document.body.textContent = 'CANDIDATE prepared convolution worklet compiled';
Object.assign(globalThis, { denPreparedConvolutionCandidate: processor });
