import { defineSubgraph, f32, f64, i32, select, state, type Node } from '@unworklet/core';

export interface VirtualAnalogConfig {
  sampleRate: number;
  waveform: 'pulse' | 'triangle';
  /** Initial/reset phase in cycles, [0,1). */
  phaseCycles?: number;
}
export interface VirtualAnalogControls {
  /** Hz, clipped to [0,.45*sampleRate]; NaN becomes zero. */
  frequencyHz: Node<'f32'>;
  /** Pulse high fraction [0,1], NaN becomes .5; ignored by triangle. */
  duty: Node<'f32'>;
  /** Level-sensitive: emit initial phase, then advance, on every true sample. */
  reset: Node<'bool'>;
}
function bounded(value: Node<'f32'>, low: number, high: number, fallback: number) {
  return select(value.eq(value), f64(value), f64(fallback)).clamp(low, high);
}

/** Alias-reduced pulse and triangle. Polynomial smoothing is not a brickwall filter. */
export const virtualAnalogSource = defineSubgraph((config: VirtualAnalogConfig) => {
  const { sampleRate, waveform, phaseCycles = 0 } = config;
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('VA sampleRate must be in [8000,192000] Hz');
  if (waveform !== 'pulse' && waveform !== 'triangle') throw new RangeError('unknown VA waveform');
  if (!Number.isFinite(phaseCycles) || phaseCycles < 0 || phaseCycles >= 1) throw new RangeError('phaseCycles must be in [0,1)');
  // Exact power-of-two scaling avoids the native |state|<1e-30 flush,
  // including f64 phaseCycles=Number.MIN_VALUE and smallest f32 Hz.
  // Phase is wrapped below1 before scaling, with >16x finite headroom.
  const scale = 2 ** 1020;
  const phase = state.f64(phaseCycles * scale).named('scaledPhase');
  return { tick(c: VirtualAnalogControls) {
    const step = bounded(c.frequencyHz, 0, .45 * sampleRate, 0).div(sampleRate);
    const p = select(c.reset, f64(phaseCycles), phase.read().div(scale));
    // Both select branches evaluate: the zero-Hz denominator must remain safe.
    const width = select(step.gt(0), step, f64(1));
    let output: Node<'f64'>;
    if (waveform === 'pulse') {
      const duty = bounded(c.duty, 0, 1, .5);
      // Rising-step residual for the unit-area triangular kernel [-1,1].
      const blep = (q: Node<'f64'>) => {
        const after = f64(1).sub(q.div(width)).max(0);
        const before = f64(1).sub(f64(1).sub(q).div(width)).max(0);
        return before.mul(before).sub(after.mul(after));
      };
      const relative = p.sub(duty), falling = relative.sub(relative.floor());
      const raw = select(p.lt(duty), f64(1), f64(-1));
      output = raw.add(select(step.gt(0), blep(p).sub(blep(falling)), f64(0)));
    } else {
      const rampResidual = (distance: Node<'f64'>) => {
        const t = f64(1).sub(distance.div(width)).max(0);
        return t.mul(t).mul(t).div(6);
      };
      const raw = f64(1).sub(p.sub(.5).abs().mul(4));
      // Slope jumps +8 at phase0 and -8 at phase.5. Support <.5 cycle,
      // so only phase0 needs the periodic image at phase1.
      const correction = rampResidual(p).add(rampResidual(f64(1).sub(p)))
        .sub(rampResidual(p.sub(.5).abs())).mul(step).mul(8);
      output = raw.add(select(step.gt(0), correction, f64(0)));
    }
    phase.write(p.add(step).frac().mul(scale));
    return f32(output);
  } };
});

export interface SeededNoiseConfig { /** Integer in [1,2147483646], default1. */ seed?: number }
/** Park–Miller 48271 white-noise candidate; deterministic, not cryptographic. */
export const seededNoise = defineSubgraph((config: SeededNoiseConfig = {}) => {
  const { seed = 1 } = config;
  if (!Number.isInteger(seed) || seed < 1 || seed > 2147483646) throw new RangeError('noise seed must be an integer in [1,2147483646]');
  const random = state.i32(seed).named('random');
  return { tick(reset: Node<'bool'>) {
    const current = select(reset, i32(seed), random.read());
    // Exact integer product in f64; i32 multiplication would overflow.
    const next = i32(f64(current).mul(48271).mod(2147483647));
    random.write(next);
    return f32(f64(next).mul(2 / 2147483647).sub(1));
  } };
});
