import { defineSubgraph, f32, f64, i32, select, state, type Node } from '@unworklet/core';

/** Matched real/Hilbert group delay; the FIR transient spans 63 samples. */
export const FREQUENCY_SHIFTER_LATENCY_SAMPLES = 31;

export interface FrequencyShifterConfig { sampleRate: number }
export interface FrequencyShifterControls {
  /** Signed Hz, clamped to [-sampleRate/4, sampleRate/4]. Zero holds phase. */
  shiftHz: Node<'f32'>;
  /** Linear, latency-aligned dry/wet blend, clamped to [0,1]. */
  mix: Node<'f32'>;
  /** Select delayed dry; history and oscillator continue running. */
  bypass: Node<'bool'>;
  /** Level reset: silence/discard this sample, clear history and phase. */
  reset: Node<'bool'>;
}

// Full-cycle degree-15 sine with f64 arithmetic and a <7e-12 remainder.
function sine(cycles: Node<'f64'>) {
  const p = cycles.sub(cycles.add(0.5).floor());
  const folded = select(p.gt(0.25), f64(0.5).sub(p), select(p.lt(-0.25), f64(-0.5).sub(p), p));
  const angle = folded.mul(2 * Math.PI), square = angle.mul(angle);
  return angle.mul(f64(-1 / 1307674368000).mul(square).add(1 / 6227020800).mul(square).sub(1 / 39916800)
    .mul(square).add(1 / 362880).mul(square).sub(1 / 5040)
    .mul(square).add(1 / 120).mul(square).sub(1 / 6).mul(square).add(1));
}

/** Fixed 63-tap Blackman Hilbert frequency shifter. Call once per sample.
 * Finite controls and normalized finite input [-1,1] required. Output may exceed
 * unity. Approximate single-sideband behavior only in the documented useful
 * band; there is no input bandpass, antialiasing, pitch-ratio or time stretching.
 */
export const frequencyShifter = defineSubgraph((config: FrequencyShifterConfig) => {
  const { sampleRate } = config;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('frequencyShifter requires an integer sampleRate in [8000,192000]');
  }
  const delay = FREQUENCY_SHIFTER_LATENCY_SAMPLES, size = 63;
  // Public 0.4.1 scrubs buffer writes below 1e-30. Exact power-of-two scaling
  // preserves the full finite normalized f32 input range, including subnormals.
  const scale = 2 ** 128;
  const history = state.buffer.f64({ size }).expose({ name: 'historyScaled', snapshot: 'persistent' });
  const cursor = state.i32(0).named('cursor');
  const valid = state.i32(0).named('valid');
  // Centered scaled phase also preserves tiny signed increments near zero.
  // As with any f64 accumulator, increments below its current ULP can stall.
  const phase = state.f64(0).named('phaseScaled');
  const quadrature = state.f64(0).expose({ name: 'quadratureScaled', snapshot: 'transient' });
  return {
    tick(input: Node<'f32'>, c: FrequencyShifterControls): Node<'f32'> {
      valid.write(select(c.reset, i32(0), valid.read().add(1).min(size)));
      history.write(cursor.read(), f64(select(c.reset, f32(0), input)).mul(scale));
      const at = (lag: number) => select(valid.read().gt(lag), history.read(cursor.read().add(size - lag).mod(size)), f64(0));
      quadrature.write(0);
      // Odd antisymmetric taps. The Blackman endpoints are exactly zero;
      // pair differences reduce the 63-tap FIR to 15 bounded multiply-adds.
      for (let offset = 1; offset < delay; offset += 2) {
        const window = 0.42 + 0.5 * Math.cos(Math.PI * offset / delay) + 0.08 * Math.cos(2 * Math.PI * offset / delay);
        quadrature.write(quadrature.read().add(at(delay + offset).sub(at(delay - offset)).mul(2 * window / (Math.PI * offset))));
      }
      const dry = at(delay), p = select(c.reset, f64(0), phase.read().div(scale));
      const wet = dry.mul(sine(p.add(0.25))).sub(quadrature.read().mul(sine(p)));
      const mix = f64(c.mix).clamp(0, 1);
      const output = select(c.bypass, dry, dry.mul(f64(1).sub(mix)).add(wet.mul(mix)));
      const next = p.add(f64(c.shiftHz).clamp(-sampleRate / 4, sampleRate / 4).div(sampleRate));
      // A held reset holds phase zero; the first subsequent sample uses zero.
      phase.write(select(c.reset, f64(0), next.sub(next.add(0.5).floor()).mul(scale)));
      cursor.write(cursor.read().add(1).mod(size));
      return select(c.reset, f32(0), f32(output.div(scale)));
    },
  };
});
