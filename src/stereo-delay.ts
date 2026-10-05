import { defineSubgraph, f32, f64, instantiate, select, state, type Node } from '@unworklet/core';
import { delayReadhead } from './delay-readhead.js';

export interface StereoDelayConfig {
  sampleRate: number;
  /** Fixed per-head capacity in seconds. Default 2; at most 8. */
  maxDelaySeconds?: number;
}
export interface DelayMixControls {
  /** Signed feedback, clamped to [-0.95, 0.95]. */
  feedback: Node<'f32'>;
  /** Linear dry/wet, clamped to [0, 1]. */
  mix: Node<'f32'>;
  bypass: Node<'bool'>;
  reset: Node<'bool'>;
}
export interface PingPongControls extends DelayMixControls {
  /** Both channel delays. Invalid time requests emit dry and reject new input. */
  timeSeconds: Node<'f32'>;
}
function validate(config: StereoDelayConfig) {
  const { sampleRate, maxDelaySeconds = 2 } = config;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      !Number.isFinite(maxDelaySeconds) || maxDelaySeconds < 1 / sampleRate || maxDelaySeconds > 8) {
    throw new RangeError('stereo delay requires integer sample rate [8000,192000] and capacity [one sample,8 seconds]');
  }
  return { sampleRate, maxDelaySeconds };
}

/** Stereo cross-feedback delay. Both heads are read before either current write. */
export const pingPongDelay = defineSubgraph((config: StereoDelayConfig) => {
  const validated = validate(config), minimum = Math.fround(1 / config.sampleRate);
  const left = instantiate(delayReadhead, validated, { name: 'left' });
  const right = instantiate(delayReadhead, validated, { name: 'right' });
  const acceptedTime = state.f32(minimum).named('acceptedTime');
  const wetLeft = state.f32(0).expose({ name: 'wetLeft', snapshot: 'transient' });
  const wetRight = state.f32(0).expose({ name: 'wetRight', snapshot: 'transient' });
  return {
    tick(inputLeft: Node<'f32'>, inputRight: Node<'f32'>, c: PingPongControls) {
      const valid = c.timeSeconds.gte(minimum).and(c.timeSeconds.lte(Math.fround(validated.maxDelaySeconds)));
      acceptedTime.write(select(valid, c.timeSeconds, select(c.reset, f32(minimum), acceptedTime.read())));
      const l = left.read(acceptedTime.read(), c.reset), r = right.read(acceptedTime.read(), c.reset);
      wetLeft.write(l.output); wetRight.write(r.output);
      const dryOnly = c.bypass.or(valid.not()), gain = c.feedback.clamp(-0.95, 0.95);
      l.write(select(dryOnly, f32(0), inputLeft).add(wetRight.read().mul(gain)));
      r.write(select(dryOnly, f32(0), inputRight).add(wetLeft.read().mul(gain)));
      const mix = c.mix.clamp(0, 1);
      return {
        left: select(dryOnly, inputLeft, inputLeft.mul(f32(1).sub(mix)).add(wetLeft.read().mul(mix))),
        right: select(dryOnly, inputRight, inputRight.mul(f32(1).sub(mix)).add(wetRight.read().mul(mix))),
        timingRejected: valid.not(),
      };
    },
  };
});

export interface DelayTap {
  /** Fixed delay, within the declared capacity. */
  delaySeconds: number;
  gainLeft: number;
  gainRight: number;
}
export interface MultiTapDelayConfig extends StereoDelayConfig {
  /** One to eight independent fixed-capacity heads. */
  taps: readonly DelayTap[];
}

/** Mono-in, stereo-out tapped delay. Gains share a construction-time divisor
 * max(1, sum(abs(left)), sum(abs(right))), preserving signs and stereo ratios.
 */
export const multiTapDelay = defineSubgraph((config: MultiTapDelayConfig) => {
  const validated = validate(config);
  if (!Array.isArray(config.taps) || config.taps.length < 1 || config.taps.length > 8 || config.taps.some(t =>
    !Number.isFinite(t.delaySeconds) || t.delaySeconds < 1 / config.sampleRate || t.delaySeconds > validated.maxDelaySeconds ||
    !Number.isFinite(t.gainLeft) || !Number.isFinite(t.gainRight) || Math.abs(t.gainLeft) > 1e6 || Math.abs(t.gainRight) > 1e6)) {
    throw new RangeError('multiTapDelay needs 1–8 finite taps within capacity and gains within [-1e6,1e6]');
  }
  const divisor = Math.max(1, config.taps.reduce((s, t) => s + Math.abs(t.gainLeft), 0), config.taps.reduce((s, t) => s + Math.abs(t.gainRight), 0));
  const taps = config.taps.map((t, i) => ({ ...t, gainLeft: t.gainLeft / divisor, gainRight: t.gainRight / divisor,
    delay: instantiate(delayReadhead, validated, { name: `tap${i}` }) }));
  const wetLeft = state.f64(0).expose({ name: 'wetLeft', snapshot: 'transient' });
  const wetRight = state.f64(0).expose({ name: 'wetRight', snapshot: 'transient' });
  const feed = state.f32(0).expose({ name: 'feed', snapshot: 'transient' });
  return {
    tick(input: Node<'f32'>, c: DelayMixControls) {
      const heads = taps.map(t => t.delay.read(f32(t.delaySeconds), c.reset));
      // All output reads precede all writes. Each delay instance is consumed once.
      wetLeft.write(heads.reduce((sum, h, i) => sum.add(f64(h.output).mul(taps[i].gainLeft)), f64(0)));
      wetRight.write(heads.reduce((sum, h, i) => sum.add(f64(h.output).mul(taps[i].gainRight)), f64(0)));
      const left = wetLeft.read(), right = wetRight.read();
      feed.write(f32(f64(select(c.bypass, f32(0), input)).add(left.add(right).mul(0.5).mul(f64(c.feedback).clamp(-0.95, 0.95)))));
      for (const h of heads) h.write(feed.read());
      const mix = f64(c.mix).clamp(0, 1), dry = f64(input).mul(f64(1).sub(mix));
      return {
        left: select(c.bypass, input, f32(dry.add(left.mul(mix)))),
        right: select(c.bypass, input, f32(dry.add(right.mul(mix)))),
      };
    },
  };
});
