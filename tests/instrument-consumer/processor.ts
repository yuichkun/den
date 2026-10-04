// Installed-file import until the shared export integration lands.
import { createInstrument } from '@denaudio/den/instrument';
export const processor = createInstrument({ mode: 'poly', capacity: 4, heldCapacity: 32 });
