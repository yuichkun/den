import { f32, f64, i32, type Node } from '@unworklet/core';
import type { ResidentSample } from './sample.js';

/** Construction helper, not a resident/runtime API. Keep the cycle-local fraction
 * separate from the absolute integer offset so tiny phase contributions survive
 * at nonzero frames/bands even against the full finite float32 PCM range. */
export function readWavetableCycle(sample: ResidentSample, phase: Node<'f64'>, start: Node<'i32'>, length: number): Node<'f32'> {
  const position = phase.mul(length), whole = i32(position.floor()), fraction = position.sub(f64(whole));
  const a = sample.read(f64(start.add(whole)), start, start.add(length), false);
  const b = sample.read(f64(start.add(whole.add(1).mod(length))), start, start.add(length), false);
  // Convex weighting avoids cancellation in a+(b-a)*fraction near the endpoint.
  return f32(f64(a).mul(f64(1).sub(fraction)).add(f64(b).mul(fraction)));
}
