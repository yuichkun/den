import { glassDyad, glassDyadParameters, makeGlassDyadTable } from '@denaudio/den/musical-examples';

// Use the public asset helper, the existing native event, and ordinary AudioParams.
const data = makeGlassDyadTable();
export const initial = { ...glassDyadParameters, gateA: 0, gateB: 0, gain: 0.18 };
export const events = [{ name: 'load', payload: { data } }];
export const ready = [{ suffix: 'asset/length', value: data.length }];
export const afterReady = { gateA: 1, gateB: 1 };
export default glassDyad;
