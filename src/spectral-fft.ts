import { defineSubgraph, f64, forIndex, i32, select, state, type Node } from '@unworklet/core';

/** Internal fixed-capacity buffer iteration, using only public native loops.
 * No audio/parameter indexing or sample-clock advancement belongs in this body.
 */
export function spectralForEach(size: number, body: (index: Node<'i32'>) => void) {
  if (size < 4 || size > 1024 || !Number.isInteger(Math.log2(size))) {
    throw new RangeError('spectral buffer iteration requires power-of-two size [4,1024]');
  }
  forIndex(size, body);
}

/** Internal sample dispatch period. Native scheduler phase is not snapshotted.
 * A divisor of both the hop and quantum realigns a fresh scheduler at every
 * block-atomic restore; persistent module cursors decide when to commit frames.
 * Keep the historical 128-sample maximum dispatch period at ordinary targets.
 */
export function spectralDispatchPeriod(hopSize: number, renderQuantumSize: number) {
  if (!Number.isInteger(renderQuantumSize) || renderQuantumSize < 1) {
    throw new RangeError('spectral renderQuantumSize must be the positive integer ctx.renderQuantumSize');
  }
  let divisor = Math.min(hopSize, 128), remaining = renderQuantumSize;
  while (remaining !== 0) [divisor, remaining] = [remaining, divisor % remaining];
  return divisor;
}

/** Internal construction-fixed FFT. Not a separate runtime or public package API. */
export const spectralFft = defineSubgraph((config: { size: number }) => {
  const { size } = config;
  if (!Number.isInteger(size) || size < 8 || size > 1024 || !Number.isInteger(Math.log2(size))) {
    throw new RangeError('spectral FFT size must be a power of two in [8,1024]');
  }
  const stages = Math.log2(size);
  const banks = [0, 1].map(bank => ({
    real: state.buffer.f64({ size }).expose({ name: `real${bank}`, snapshot: 'transient' }),
    imag: state.buffer.f64({ size }).expose({ name: `imag${bank}`, snapshot: 'transient' }),
  }));
  const twiddleReal = state.f64(1).expose({ name: 'twiddleReal', snapshot: 'transient' });
  const twiddleImag = state.f64(0).expose({ name: 'twiddleImag', snapshot: 'transient' });
  const reverse = (index: Node<'i32'>) => {
    let result = i32(0);
    for (let bit = 0; bit < stages; bit++) result = result.add(index.div(2 ** bit).mod(2).mul(2 ** (stages - 1 - bit)));
    return result;
  };
  return {
    /** JS functions/loops run during graph capture. Butterfly iteration uses the
     * public fixed-count native forIndex loop over work-buffer indices, nested
     * inside the caller's hop body. It performs no audio I/O or audio-time update.
     * Inputs must not alias these work buffers.
     * Result aliases scratch and must be consumed before the next transform.
     * Forward: sum x[n] exp(-i*2*pi*k*n/N). Inverse: positive sign and 1/N.
     */
    transform(real: (index: Node<'i32'>) => Node<'f64'>, imag: (index: Node<'i32'>) => Node<'f64'>, inverse: boolean) {
      spectralForEach(size, index => {
        banks[0].real.write(reverse(index), real(index));
        banks[0].imag.write(reverse(index), imag(index));
      });
      for (let stage = 0; stage < stages; stage++) {
        const width = 2 ** (stage + 1), half = width / 2;
        const source = banks[stage % 2], target = banks[(stage + 1) % 2];
        const angle = (inverse ? 1 : -1) * 2 * Math.PI / width;
        const cosineStep = Math.cos(angle), sineStep = Math.sin(angle);
        spectralForEach(size / 2, index => {
          const j = index.mod(half);
          const a = index.div(half).mul(width).add(j), b = a.add(half);
          // Each butterfly group starts at exactly (1,0); a bounded recurrence
          // advances its twiddle without a table loader or runtime trig calls.
          const cosine = select(j.eq(0), f64(1), twiddleReal.read());
          const sine = select(j.eq(0), f64(0), twiddleImag.read());
          const ar = source.real.read(a), ai = source.imag.read(a);
          const br = source.real.read(b), bi = source.imag.read(b);
          const tr = br.mul(cosine).sub(bi.mul(sine)), ti = br.mul(sine).add(bi.mul(cosine));
          target.real.write(a, ar.add(tr)); target.imag.write(a, ai.add(ti));
          target.real.write(b, ar.sub(tr)); target.imag.write(b, ai.sub(ti));
          twiddleReal.write(cosine.mul(cosineStep).sub(sine.mul(sineStep)));
          twiddleImag.write(cosine.mul(sineStep).add(sine.mul(cosineStep)));
        });
      }
      const result = banks[stages % 2], scale = inverse ? 1 / size : 1;
      return { real: (index: number | Node<'i32'>) => result.real.read(index).mul(scale), imag: (index: number | Node<'i32'>) => result.imag.read(index).mul(scale) };
    },
  };
});
