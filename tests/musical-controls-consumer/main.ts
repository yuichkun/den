import envelope from './processor.ts?worklet';
import lfo from './lfo-processor.ts?worklet';
document.body.textContent = 'CANDIDATE curved ADSR and musical LFO worklets compiled';
Object.assign(globalThis, { musicalControlProcessors: [envelope, lfo] });
