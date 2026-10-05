import { defineSubgraph, f32, f64, instantiate, select, sqrt, state, type Node } from '@unworklet/core';
import { delayFx } from './delay-fx.js';

export interface FlangerConfig {
  sampleRate: number;
  /** Fixed capacity in seconds, [one sample, 0.02]. Default 0.02. */
  maxDelaySeconds?: number;
  /** Right LFO phase relative to left, in cycles. Default 0.5. */
  stereoPhaseCycles?: number;
}
export interface FlangerControls {
  delaySeconds: Node<'f32'>;
  depthSeconds: Node<'f32'>;
  rateHz: Node<'f32'>;
  /** Positive feedback, clamped to [0, 0.95]. */
  feedback: Node<'f32'>;
  mix: Node<'f32'>;
  bypass: Node<'bool'>;
  reset: Node<'bool'>;
}

/** Stereo moving-head comb/flanger. Call once per sample; finite inputs required. */
export const flanger = defineSubgraph((config: FlangerConfig) => {
  const maxDelaySeconds = config.maxDelaySeconds ?? 0.02;
  if (!Number.isFinite(maxDelaySeconds) || maxDelaySeconds < 1 / config.sampleRate || maxDelaySeconds > 0.02) {
    throw new RangeError('flanger capacity must be between one sample and 0.02 seconds');
  }
  const engine = instantiate(delayFx, { ...config, maxDelaySeconds, tone: 'flat' }, { name: 'delay' });
  return {
    tick(left: Node<'f32'>, right: Node<'f32'>, c: FlangerControls) {
      return engine.tick(left, right, {
        timeLeftSeconds: c.delaySeconds, timeRightSeconds: c.delaySeconds,
        sync: f32(0).gt(1), bpm: f32(120), beatsLeft: f32(1), beatsRight: f32(1),
        feedback: c.feedback, cutoffHz: f32(1000), mix: c.mix,
        rateHz: c.rateHz, depthSeconds: c.depthSeconds,
        bypass: c.bypass, reset: c.reset,
      });
    },
  };
});

export interface PhaserConfig {
  sampleRate: number;
  /** Fixed number of normalized first-order allpasses. Default 4. */
  stages?: 2 | 4 | 6 | 8;
}
export interface PhaserControls {
  /** Per-stage -90 degree frequency. Clamped to [20, 0.45 * sampleRate]. */
  frequencyHz: Node<'f32'>;
  /** One-sample-delayed wet feedback, clamped to [-0.95, 0.95]. */
  feedback: Node<'f32'>;
  mix: Node<'f32'>;
  bypass: Node<'bool'>;
  reset: Node<'bool'>;
}

/** Mono allpass phaser, not a delay preset. Compose two instances for stereo.
 * Normalized lattice scattering preserves per-sample energy under cutoff motion.
 */
export const phaser = defineSubgraph((config: PhaserConfig) => {
  const { sampleRate, stages = 4 } = config;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || ![2, 4, 6, 8].includes(stages)) {
    throw new RangeError('phaser requires an integer sample rate in [8000,192000] and 2/4/6/8 stages');
  }
  const history = Array.from({ length: stages }, (_, i) => state.f64(0).named(`stage${i}`));
  const signal = state.f64(0).expose({ name: 'signal', snapshot: 'transient' });
  const coefficient = state.f64(0).expose({ name: 'coefficient', snapshot: 'transient' });
  const coupling = state.f64(0).expose({ name: 'coupling', snapshot: 'transient' });
  const feedback = state.f64(0).named('feedback');
  return {
    tick(input: Node<'f32'>, c: PhaserControls) {
      const angle = f64(c.frequencyHz).clamp(20, 0.45 * sampleRate).mul(Math.PI / sampleRate);
      const z = angle.mul(angle);
      // Degree 13/14 sine/cosine on [0, .45*pi], as in the existing SVF.
      const sine = angle.mul(f64(-1 / 6227020800).mul(z).add(1 / 39916800).mul(z).sub(1 / 362880).mul(z).add(1 / 5040).mul(z).sub(1 / 120).mul(z).add(1 / 6).mul(z).neg().add(1));
      const cosine = f64(-1 / 87178291200).mul(z).add(1 / 479001600).mul(z).sub(1 / 3628800).mul(z).add(1 / 40320).mul(z).sub(1 / 720).mul(z).add(1 / 24).mul(z).sub(1 / 2).mul(z).add(1);
      coefficient.write(sine.sub(cosine).div(sine.add(cosine)).clamp(-0.999999, 0.999999));
      const a = coefficient.read();
      coupling.write(sqrt(f64(1).sub(a.mul(a)).clamp(0, 1)));
      const b = coupling.read();
      signal.write(f64(select(c.bypass, f32(0), input)).add(select(c.reset, f64(0), feedback.read()).mul(f64(c.feedback).clamp(-0.95, 0.95))));
      for (const slot of history) {
        const x = signal.read(), previous = select(c.reset, f64(0), slot.read());
        signal.write(a.mul(x).add(b.mul(previous)));
        slot.write(b.mul(x).sub(a.mul(previous)));
      }
      const wet = signal.read();
      feedback.write(wet);
      const mix = f64(c.mix).clamp(0, 1);
      return select(c.bypass, input, f32(f64(input).mul(f64(1).sub(mix)).add(wet.mul(mix))));
    },
  };
});
