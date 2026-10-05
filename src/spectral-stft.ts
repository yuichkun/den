import { f32, f64, i32, instantiate, select, state, type EveryNSamples, type Node } from '@unworklet/core';
import { spectralFft, spectralForEach } from './spectral-fft.js';

/** Internal construction only. Public wrappers choose their reviewed capacity. */
export function createStftIdentity(config: { size: number; hopSize: number }, maximumSize: number) {
  const { size, hopSize } = config;
  if (!Number.isInteger(size) || size < 8 || size > maximumSize || !Number.isInteger(Math.log2(size)) ||
      (hopSize !== size / 2 && hopSize !== size / 4)) {
    throw new RangeError(`stftIdentity requires power-of-two size [8,${maximumSize}] and hopSize size/2 or size/4`);
  }
  const fft = instantiate(spectralFft, { size }, { name: 'fft' });
  // Public 0.4.1 flushes buffer writes below 1e-30. Exact power-of-two
  // scaling retains finite f32 subnormals without adding an audio threshold.
  const scale = 2 ** 128;
  const history = state.buffer.f64({ size }).expose({ name: 'historyScaled', snapshot: 'persistent' });
  const overlap = state.buffer.f64({ size }).expose({ name: 'overlap', snapshot: 'persistent' });
  // Separate spectrum avoids aliasing FFT input with its bit-reversal workspace.
  const real = state.buffer.f64({ size }).expose({ name: 'spectrumReal', snapshot: 'transient' });
  const imag = state.buffer.f64({ size }).expose({ name: 'spectrumImag', snapshot: 'transient' });
  const cursor = state.i32(0).named('cursor');
  const valid = state.i32(0).named('valid');
  const pendingReset = state.bool(true).named('pendingReset');
  const window = state.buffer.f64({ size }).expose({ name: 'window', snapshot: 'transient' });
  const windowReal = state.f64(1).expose({ name: 'windowReal', snapshot: 'transient' });
  const windowImag = state.f64(0).expose({ name: 'windowImag', snapshot: 'transient' });
  const cosineStep = Math.cos(Math.PI / size), sineStep = Math.sin(Math.PI / size);
  const normalization = 2 * hopSize / size;
  return {
    tick(input: Node<'f32'>, reset: Node<'bool'>, everyNSamples: EveryNSamples): Node<'f32'> {
      valid.write(select(reset, i32(0), valid.read()));
      pendingReset.write(pendingReset.read().or(reset));
      // Native hop counters are not snapshot state in 0.4.1. Dispatch at a
      // period dividing the 128-sample snapshot boundary; the named persistent
      // ring cursor carries the actual H phase. For H>128 this eagerly computes
      // an FFT pair every 128 samples, committing only at the true frame phase.
      // No CPU-saving claim is attached to the select-based commit condition.
      everyNSamples(Math.min(hopSize, 128), () => {
        const frameDue = cursor.read().mod(hopSize).eq(0);
        // sin(pi*n/N) equals the nonnegative periodic sqrt-Hann window.
        // Reanchor per frame; one native buffer loop replaces N code copies.
        windowReal.write(1); windowImag.write(0);
        spectralForEach(size, n => {
          const cosine = windowReal.read(), sine = windowImag.read();
          window.write(n, sine);
          windowReal.write(cosine.mul(cosineStep).sub(sine.mul(sineStep)));
          windowImag.write(cosine.mul(sineStep).add(sine.mul(cosineStep)));
        });
        const spectrum = fft.transform(n => select(valid.read().gte(i32(size).sub(n)), history.read(cursor.read().add(n).mod(size)), f64(0)).mul(window.read(n)), () => f64(0), false);
        spectralForEach(size, n => { real.write(n, spectrum.real(n)); imag.write(n, spectrum.imag(n)); });
        const frame = fft.transform(n => real.read(n), n => imag.read(n), true);
        spectralForEach(size, n => {
          const at = cursor.read().add(n).mod(size);
          const previous = overlap.read(at);
          overlap.write(at, select(frameDue, select(pendingReset.read(), f64(0), previous).add(frame.real(n).mul(window.read(n)).mul(normalization)), previous));
        });
        pendingReset.write(pendingReset.read().and(frameDue.not()));
      });
      const output = select(reset.or(pendingReset.read()), f32(0), f32(overlap.read(cursor.read()).div(scale)));
      // Reads in this DSL are captured at use, before the corresponding writes.
      overlap.write(cursor.read(), f64(0));
      history.write(cursor.read(), f64(select(reset, f32(0), input)).mul(scale));
      cursor.write(cursor.read().add(1).mod(size));
      valid.write(select(reset, i32(0), valid.read().add(1).min(size)));
      return output;
    },
  };
}
