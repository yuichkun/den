import { defineSubgraph } from '@unworklet/core';
import { createStftIdentity } from './spectral-stft.js';

export interface StftIdentityConfig {
  /** Construction-fixed power of two in [8,1024]. Latency is size samples. */
  size: number;
  /** Exactly size/2 or size/4. Rebuild to change. */
  hopSize: number;
}

/** Graph-native FFT/IFFT identity candidate, periodic sqrt-Hann WOLA.
 * Call exactly once inside stride-1 forSample, supplying its everyNSamples.
 * Finite f32 input required. Reset silences immediately and discards that sample.
 * Reset does not rephase frames. For hops above128, FFT work still runs every
 * 128 samples; the persistent cursor controls frame commits and snapshot phase.
 * No realtime guarantee.
 */
export const stftIdentity = defineSubgraph((config: StftIdentityConfig) => createStftIdentity(config, 1024));
