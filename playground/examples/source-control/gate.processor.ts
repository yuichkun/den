import { gate } from '@denaudio/den/gate';

// A complete processor: mono input/output, one-sample memory, native gain AudioParam.
// Run connects the visible quiet native source to node.inputs.main.
export const initial = { gain: 0.5 };
export default gate;
