import { defineSubgraph, f32, f64, i32, instantiate, select, state, type EveryNSamples, type Node } from '@unworklet/core';
import { spectralFft } from './spectral-fft.js';

export interface PartitionedConvolutionConfig {
  /** Construction-fixed power of two in [4,32]. FFT size is twice this value. */
  blockSize: number;
  /** Fixed IR, length 1..4*blockSize. Every tap in [-1,1], total absolute gain <=4. */
  impulse: readonly number[];
}

/** Bounded uniform-partition convolution candidate, exactly blockSize latency.
 * Call once per sample in stride-1 forSample with its native everyNSamples.
 * Input must be finite normalized audio [-1,1]. No IR loader/swap or dry path.
 * Level reset silences immediately and discards its input without rephasing hops.
 */
export const partitionedConvolution = defineSubgraph((config: PartitionedConvolutionConfig) => {
  const { blockSize: block } = config;
  if (!Number.isInteger(block) || block < 4 || block > 32 || !Number.isInteger(Math.log2(block)) ||
      !Array.isArray(config.impulse) || config.impulse.length < 1 || config.impulse.length > 4 * block ||
      Array.from(config.impulse).some(tap => !Number.isFinite(tap) || Math.abs(tap) > 1) ||
      config.impulse.reduce((sum, tap) => sum + Math.abs(tap), 0) > 4) {
    throw new RangeError('partitionedConvolution requires power-of-two blockSize [4,32], 1..4*blockSize finite IR taps in [-1,1], and IR absolute sum <=4');
  }
  const impulse = [...config.impulse], size = 2 * block, partitions = Math.ceil(impulse.length / block);
  // Construction-only O(P*N*B) coefficient preparation. No host FFT runtime,
  // asset read, callback allocation or coefficient update on the audio thread.
  const spectra = Array.from({ length: partitions }, (_, p) => Array.from({ length: size }, (_, k) => {
    let real = 0, imag = 0;
    for (let n = 0; n < block; n++) {
      const tap = impulse[p * block + n] ?? 0, angle = -2 * Math.PI * k * n / size;
      real += tap * Math.cos(angle); imag += tap * Math.sin(angle);
    }
    return { real, imag };
  }));
  const fft = instantiate(spectralFft, { size }, { name: 'fft' });
  const scale = 2 ** 128;
  const history = state.buffer.f64({ size: block }).expose({ name: 'historyScaled', snapshot: 'persistent' });
  const previousReal = state.buffer.f64({ size: partitions * size }).expose({ name: 'previousReal', snapshot: 'persistent' });
  const previousImag = state.buffer.f64({ size: partitions * size }).expose({ name: 'previousImag', snapshot: 'persistent' });
  const mixedReal = state.buffer.f64({ size }).expose({ name: 'mixedReal', snapshot: 'transient' });
  const mixedImag = state.buffer.f64({ size }).expose({ name: 'mixedImag', snapshot: 'transient' });
  const overlap = state.buffer.f64({ size }).expose({ name: 'overlap', snapshot: 'persistent' });
  const cursor = state.i32(0).named('cursor');
  const spectrumCursor = state.i32(0).named('spectrumCursor');
  const validSamples = state.i32(0).named('validSamples');
  const validBlocks = state.i32(0).named('validBlocks');
  const pendingReset = state.bool(true).named('pendingReset');
  return {
    tick(input: Node<'f32'>, reset: Node<'bool'>, everyNSamples: EveryNSamples): Node<'f32'> {
      validSamples.write(select(reset, i32(0), validSamples.read()));
      validBlocks.write(select(reset, i32(0), validBlocks.read()));
      pendingReset.write(pendingReset.read().or(reset));
      everyNSamples(block, () => {
        const transformed = fft.transform(n => select(n.lt(block).and(validSamples.read().gte(i32(block).sub(n))),
          history.read(cursor.read().add(n).mod(block)), f64(0)), () => f64(0), false);
        for (let k = 0; k < size; k++) {
          previousReal.write(spectrumCursor.read().mul(size).add(k), transformed.real(k));
          previousImag.write(spectrumCursor.read().mul(size).add(k), transformed.imag(k));
        }
        for (let k = 0; k < size; k++) {
          let real = f64(0), imag = f64(0);
          for (let p = 0; p < partitions; p++) {
            const index = spectrumCursor.read().add(partitions - p).mod(partitions).mul(size).add(k);
            const xr = select(validBlocks.read().gte(p), previousReal.read(index), f64(0));
            const xi = select(validBlocks.read().gte(p), previousImag.read(index), f64(0));
            real = real.add(xr.mul(spectra[p][k].real).sub(xi.mul(spectra[p][k].imag)));
            imag = imag.add(xr.mul(spectra[p][k].imag).add(xi.mul(spectra[p][k].real)));
          }
          mixedReal.write(k, real); mixedImag.write(k, imag);
        }
        const frame = fft.transform(n => mixedReal.read(n), n => mixedImag.read(n), true);
        for (let n = 0; n < size; n++) {
          const index = cursor.read().add(n).mod(size);
          overlap.write(index, select(pendingReset.read(), f64(0), overlap.read(index)).add(frame.real(n)));
        }
        spectrumCursor.write(spectrumCursor.read().add(1).mod(partitions));
        validBlocks.write(validBlocks.read().add(1).min(partitions - 1));
        pendingReset.write(false);
      });
      const output = select(reset.or(pendingReset.read()), f32(0), f32(overlap.read(cursor.read()).div(scale)));
      overlap.write(cursor.read(), f64(0));
      history.write(cursor.read().mod(block), f64(select(reset, f32(0), input)).mul(scale));
      cursor.write(cursor.read().add(1).mod(size));
      validSamples.write(select(reset, i32(0), validSamples.read().add(1).min(block)));
      return output;
    },
  };
});
