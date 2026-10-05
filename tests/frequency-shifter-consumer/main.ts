import processor from './processor.ts?worklet';
document.body.textContent = 'CANDIDATE frequency-shifter worklet compiled';
Object.assign(globalThis, { denFrequencyShifterCandidate: processor });
