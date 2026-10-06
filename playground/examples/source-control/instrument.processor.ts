import { createInstrument, bassParameters } from '@denaudio/den/instrument';

// The ready-made engine uses native AudioParams and a native MIDI input.
export const initial = { ...bassParameters, gain: 0.16 };
export const midi = [{ port: 'midi', event: { type: 'noteOn', channel: 0, note: 45, velocity: 100 } }];
export default createInstrument({ mode: 'mono', heldCapacity: 4, waveform: 'saw' });
