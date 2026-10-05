import { makeProcessor } from './performance-fixture.ts';
// The existing packed composition, with a small browser voice budget.
export default makeProcessor({ mode: 'poly', capacity: 1, heldCapacity: 4 });
