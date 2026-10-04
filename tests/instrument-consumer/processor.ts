// Installed-file import until the shared export integration lands.
import { createInstrument } from './node_modules/@denaudio/den/dist/instrument.js';
export const processor = createInstrument({ mode: 'poly', capacity: 4, heldCapacity: 32 });
