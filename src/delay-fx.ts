import { defineSubgraph, instantiate, f32, f64, select, state, type Node } from '@unworklet/core';
import { delayReadhead } from './delay-readhead.js';
import { filter } from './filter.js';
import { lfo, modulateDelay } from './lfo.js';

export interface DelayFxConfig {
  sampleRate: number;
  /** Fixed allocation per channel; eight seconds is a configurable starting default. */
  maxDelaySeconds?: number;
  /** Immutable feedback tone mode. Flat is useful when uncolored repeats are wanted. */
  tone?: 'lowpass' | 'flat';
  /** Right LFO phase relative to left, in cycles. Default 0.5 (opposite motion). */
  stereoPhaseCycles?: number;
}
export interface DelayFxControls {
  timeLeftSeconds: Node<'f32'>;
  timeRightSeconds: Node<'f32'>;
  /** When true, use 60 * beats / bpm. One beat is a quarter note. */
  sync: Node<'bool'>;
  bpm: Node<'f32'>;
  beatsLeft: Node<'f32'>;
  beatsRight: Node<'f32'>;
  feedback: Node<'f32'>;
  cutoffHz: Node<'f32'>;
  mix: Node<'f32'>;
  rateHz: Node<'f32'>;
  depthSeconds: Node<'f32'>;
  bypass: Node<'bool'>;
  reset: Node<'bool'>;
}

/** One stereo delay FX engine. Tick once per sample; duplicate mono input explicitly.
 * Finite audio/controls required. See docs/delay-fx.md for bounds and acoustic policies.
 */
export const delayFx = defineSubgraph((config: DelayFxConfig) => {
  const { sampleRate, maxDelaySeconds = 8, tone = 'lowpass', stereoPhaseCycles = 0.5 } = config;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      !['lowpass', 'flat'].includes(tone) || !Number.isFinite(stereoPhaseCycles)) {
    throw new RangeError('delayFx requires an integer rate in [8000,192000], lowpass/flat tone and finite stereo phase');
  }
  const left = instantiate(delayReadhead, { sampleRate, maxDelaySeconds }, { name: 'left' });
  const right = instantiate(delayReadhead, { sampleRate, maxDelaySeconds }, { name: 'right' });
  const toneLeft = instantiate(filter, { sampleRate }, { name: 'toneLeft' });
  const toneRight = instantiate(filter, { sampleRate }, { name: 'toneRight' });
  const lfoLeft = instantiate(lfo, { sampleRate }, { name: 'lfoLeft' });
  const lfoRight = instantiate(lfo, { sampleRate }, { name: 'lfoRight' });
  // Materialize per-sample values in existing unworklet scalar slots. Without
  // these boundaries 0.4.1 recursively expands the composed expression DAG.
  // They are overwritten before use each sample and are not snapshot history.
  const signalLeft = state.f32(0).expose({ name: 'signalLeft', snapshot: 'transient' });
  const signalRight = state.f32(0).expose({ name: 'signalRight', snapshot: 'transient' });
  const timeLeft = state.f32(0).expose({ name: 'timeLeft', snapshot: 'transient' });
  const timeRight = state.f32(0).expose({ name: 'timeRight', snapshot: 'transient' });
  const wetLeft = state.f32(0).expose({ name: 'wetLeft', snapshot: 'transient' });
  const wetRight = state.f32(0).expose({ name: 'wetRight', snapshot: 'transient' });
  const timingValid = state.bool(false).expose({ name: 'timingValid', snapshot: 'transient' });
  const toneCutoff = state.f32(0).expose({ name: 'toneCutoff', snapshot: 'transient' });
  const first = state.bool(true).named('first');
  const minimum = Math.fround(1 / sampleRate), maximum = Math.fround(maxDelaySeconds);
  const acceptedLeft = state.f32(minimum).named('acceptedLeft');
  const acceptedRight = state.f32(minimum).named('acceptedRight');
  return {
    tick(inputLeft: Node<'f32'>, inputRight: Node<'f32'>, c: DelayFxControls) {
      const seconds = (beats: Node<'f32'>) => f32(f64(beats).mul(60).div(f64(c.bpm).clamp(30, 300)));
      const requestedLeft = select(c.sync, seconds(c.beatsLeft), c.timeLeftSeconds);
      const requestedRight = select(c.sync, seconds(c.beatsRight), c.timeRightSeconds);
      const within = (time: Node<'f32'>) => time.gte(minimum).and(time.lte(maximum));
      const tempoValid = c.bpm.gte(30).and(c.bpm.lte(300));
      timingValid.write(within(requestedLeft).and(within(requestedRight)).and(c.sync.not().or(tempoValid)));
      const valid = timingValid.read();
      // Reject the entire stereo request: keep the previous rhythm internally,
      // stop new input and emit dry. Never present clamped time as an exact rhythm.
      acceptedLeft.write(select(valid, requestedLeft, select(c.reset, f32(minimum), acceptedLeft.read())));
      acceptedRight.write(select(valid, requestedRight, select(c.reset, f32(minimum), acceptedRight.read())));
      // Reuse this sample's accepted state instead of expanding its selection again.
      const baseLeft = acceptedLeft.read(), baseRight = acceptedRight.read();
      const phaseReset = c.reset.or(first.read());
      signalLeft.write(lfoLeft.tick(c.rateHz, phaseReset, f32(0)));
      signalRight.write(lfoRight.tick(c.rateHz, phaseReset, f32(stereoPhaseCycles - Math.floor(stereoPhaseCycles))));
      const modulationLeft = signalLeft.read(), modulationRight = signalRight.read();
      first.write(false);
      const rawLeft = baseLeft.add(modulationLeft.mul(c.depthSeconds.clamp(0, 0.05)));
      const rawRight = baseRight.add(modulationRight.mul(c.depthSeconds.clamp(0, 0.05)));
      const modulationClipped = within(rawLeft).and(within(rawRight)).not();
      const delayLeft = modulateDelay(baseLeft, modulationLeft, c.depthSeconds, minimum, maximum);
      const delayRight = modulateDelay(baseRight, modulationRight, c.depthSeconds, minimum, maximum);
      timeLeft.write(delayLeft); timeRight.write(delayRight);
      const tapLeft = left.read(timeLeft.read(), c.reset), tapRight = right.read(timeRight.read(), c.reset);
      wetLeft.write(tapLeft.output); wetRight.write(tapRight.output);
      // Q=0.5 and g=tan(pi*fc/fs)<1 admit a positive two-stage realization.
      // The 0.24*fs ceiling keeps a margin below g=1, even with coefficient error.
      toneCutoff.write(c.cutoffHz.clamp(20, Math.min(20000, 0.24 * sampleRate)));
      const cutoff = toneCutoff.read();
      const filteredLeft = toneLeft.tick(wetLeft.read(), cutoff, f32(0.5), c.reset);
      const filteredRight = toneRight.tick(wetRight.read(), cutoff, f32(0.5), c.reset);
      const gain = c.feedback.clamp(0, 0.95);
      const dryOnly = c.bypass.or(valid.not());
      tapLeft.write(select(dryOnly, f32(0), inputLeft).add((tone === 'flat' ? wetLeft.read() : filteredLeft).mul(gain)));
      tapRight.write(select(dryOnly, f32(0), inputRight).add((tone === 'flat' ? wetRight.read() : filteredRight).mul(gain)));
      const mix = c.mix.clamp(0, 1);
      return {
        left: select(dryOnly, inputLeft, inputLeft.mul(f32(1).sub(mix)).add(wetLeft.read().mul(mix))),
        right: select(dryOnly, inputRight, inputRight.mul(f32(1).sub(mix)).add(wetRight.read().mul(mix))),
        timingRejected: valid.not(),
        modulationClipped,
      };
    },
  };
});
