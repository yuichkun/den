import { bool, defineSubgraph, f32, f64, instantiate, select, type EveryNSamples, type Node } from '@unworklet/core';
import { partitionedConvolution } from './convolution.js';
import { multiTapDelay } from './stereo-delay.js';
import { algorithmicReverb } from './reverb.js';
import { windowedPitchShift } from './windowed-pitch-shift.js';

export interface SpatialChainConfig {
  /** Match the enclosing ctx.sampleRate; integer 8000..192000. */
  sampleRate: number;
}
export interface SpatialChainControls {
  /** Finite linear dry/wet, clamped to [0,1]. Zero still feeds the wet paths. */
  mix: Node<'f32'>;
  /** Unity dry, no new wet excitation; all existing tails keep processing. */
  bypass: Node<'bool'>;
  /** Highest priority: silence, discard current input and invalidate history. */
  reset: Node<'bool'>;
}
export interface FeedforwardPitchedReverbConfig extends SpatialChainConfig {
  /** Fixed pitch delay excursion: even integer 32..16384, default 2048. */
  windowSamples?: number;
}
export interface FeedforwardPitchedReverbControls extends SpatialChainControls {
  /** Reader speed [.5,2]. Invalid values retain the prior ratio, or 1 on reset. */
  ratio: Node<'f32'>;
  /** Finite unpitched/pitched late blend, clamped [0,1]. Readers always advance. */
  pitchMix: Node<'f32'>;
  /** Rephase the current pitch read while retaining history. Can click. */
  retrigger: Node<'bool'>;
}

// Construction-only composition. Each existing module retains its own state,
// scheduler and native snapshot contract; no new runtime routing is introduced.
function spatialPaths({ sampleRate }: SpatialChainConfig) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError('spatial chains require integer sampleRate [8000,192000]');
  }
  const color = instantiate(partitionedConvolution, {
    blockSize: 8, impulse: [.625, 0, 0, .25, 0, 0, 0, -.125],
  }, { name: 'earlyColor' });
  const reflections = instantiate(multiTapDelay, {
    sampleRate, maxDelaySeconds: .023,
    taps: [
      { delaySeconds: .007, gainLeft: .5, gainRight: .25 },
      { delaySeconds: .013, gainLeft: .25, gainRight: -.25 },
      { delaySeconds: .023, gainLeft: -.125, gainRight: .375 },
    ],
  }, { name: 'earlyTaps' });
  const late = instantiate(algorithmicReverb, {
    sampleRate, roomScale: 1, decaySeconds: .6, dampingHz: Math.min(3500, .4 * sampleRate),
  }, { name: 'late' });
  return {
    tick(input: Node<'f32'>, c: SpatialChainControls, everyNSamples: EveryNSamples) {
      const excitation = select(c.reset.or(c.bypass), f32(0), input);
      const early = reflections.tick(color.tick(excitation, c.reset, everyNSamples), {
        feedback: f32(0), mix: f32(1), bypass: bool(false), reset: c.reset,
      });
      const tail = late.tick(excitation, f32(0), { mix: f32(1), bypass: bool(false), reset: c.reset });
      return { early, tail };
    },
  };
}

function blend(input: Node<'f32'>, early: Node<'f32'>, late: Node<'f64'>, c: SpatialChainControls) {
  const mix = f64(c.mix).clamp(0, 1), wet = f64(early).add(late).mul(.5);
  return select(c.reset, f32(0), select(c.bypass, input,
    f32(f64(input).mul(f64(1).sub(mix)).add(wet.mul(mix)))));
}

/** CANDIDATE mono-in/stereo-out short FIR + three early taps || damped FDN.
 * Finite normalized input [-1,1]; no limiter. Dry is immediate, early has B8
 * latency plus 7/13/23ms taps, and late begins near 29.7ms with an IIR tail.
 * Call once per sample in stride-1 forSample with its native everyNSamples.
 */
export const hybridReverb = defineSubgraph((config: SpatialChainConfig) => {
  const paths = spatialPaths(config);
  return {
    tick(input: Node<'f32'>, c: SpatialChainControls, everyNSamples: EveryNSamples) {
      const { early, tail } = paths.tick(input, c, everyNSamples);
      return { left: blend(input, early.left, f64(tail.left), c), right: blend(input, early.right, f64(tail.right), c) };
    },
  };
});

/** Same hybrid space with pitch applied only to a feedforward copy of its FDN
 * output. No pitched signal enters the FDN or early path. This is
 * not regenerative shimmer. Pitch adds variable 1..W+1-sample read ages, with
 * interpolation aliasing/window coloration; parallel blending can cancel.
 */
export const feedforwardPitchedReverb = defineSubgraph((config: FeedforwardPitchedReverbConfig) => {
  const paths = spatialPaths(config);
  const left = instantiate(windowedPitchShift, config, { name: 'pitchLeft' });
  const right = instantiate(windowedPitchShift, config, { name: 'pitchRight' });
  return {
    tick(input: Node<'f32'>, c: FeedforwardPitchedReverbControls, everyNSamples: EveryNSamples) {
      const { early, tail } = paths.tick(input, c, everyNSamples);
      const l = left.tick(tail.left, c), r = right.tick(tail.right, c);
      const mix = f64(c.pitchMix).clamp(0, 1), dry = f64(1).sub(mix);
      return {
        left: blend(input, early.left, f64(tail.left).mul(dry).add(f64(l.output).mul(mix)), c),
        right: blend(input, early.right, f64(tail.right).mul(dry).add(f64(r.output).mul(mix)), c),
        ratioRejected: l.ratioRejected,
      };
    },
  };
});
