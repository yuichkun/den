import { defineSubgraph, f32, f64, i32, select, state, type Node } from '@unworklet/core';

export interface FreezeReverbConfig {
  /** Match ctx.sampleRate; integer 8000..192000. */
  sampleRate: number;
  /** Fixed delay-length scale, [0.5,2], default 1. Rebuild to change. */
  roomScale?: number;
  /** Fixed nominal loop-loss time, [0.1,10] seconds, default 1.5.
   * Describes the unfrozen network, not a frozen-tail duration. */
  decaySeconds?: number;
  /** Samples from fully live to fully frozen, or back; integer 0..192000.
   * Default 256. Zero switches immediately and may click. Reversals continue
   * from the current integer progress, without restarting the ramp. */
  transitionSamples?: number;
}
export interface FreezeReverbControls {
  /** Level control: ramp to muted excitation + unity feedback while true. */
  freeze: Node<'bool'>;
  /** Highest priority: output silence, discard current excitation, invalidate
   * all delay history and set progress to live. Held reset keeps doing this. */
  reset: Node<'bool'>;
}

// Exact binary representation scaling, not audio normalization. Keeps the
// smallest f32 excitations above the native tiny-state scrub threshold.
const SCALE = 2 ** 256;
const ROWS = [[1, 1, 1, 1], [1, -1, 1, -1], [1, 1, -1, -1], [1, -1, -1, 1]];

/** Wet-only four-line integer-delay FDN. Call tick exactly once per sample.
 * The fully frozen, unforced real-arithmetic network preserves stored energy.
 * Actual f64 state has rounding and very-small-state limits, not perpetual
 * exact energy. Finite normalized inputs and adequate output headroom required.
 * No interpolation, damping filter, shimmer, limiter, dry path or normalization.
 */
export const freezeReverb = defineSubgraph((config: FreezeReverbConfig) => {
  const { sampleRate, roomScale = 1, decaySeconds = 1.5, transitionSamples = 256 } = config;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      !Number.isFinite(roomScale) || roomScale < 0.5 || roomScale > 2 ||
      !Number.isFinite(decaySeconds) || decaySeconds < 0.1 || decaySeconds > 10 ||
      !Number.isInteger(transitionSamples) || transitionSamples < 0 || transitionSamples > 192000) {
    throw new RangeError('freezeReverb requires integer sampleRate [8000,192000], roomScale [0.5,2], decaySeconds [0.1,10], integer transitionSamples [0,192000]');
  }
  const steps = Math.max(1, transitionSamples);
  const progress = state.i32(0).named('freezeProgress');
  const lines = [0.0297, 0.0371, 0.0411, 0.0437].map((seconds, index) => {
    const size = Math.round(seconds * roomScale * sampleRate);
    return {
      size,
      gain: 10 ** (-3 * size / (sampleRate * decaySeconds)),
      history: state.buffer.f64({ size }).expose({ name: `line${index}/historyScaled`, snapshot: 'persistent' }),
      cursor: state.i32(0).named(`line${index}/cursor`),
      valid: state.i32(0).named(`line${index}/valid`),
      wet: state.f64(0).expose({ name: `line${index}/wetScaled`, snapshot: 'transient' }),
    };
  });
  return {
    tick(inputLeft: Node<'f32'>, inputRight: Node<'f32'>, c: FreezeReverbControls) {
      const next = transitionSamples === 0
        ? select(c.freeze, i32(1), i32(0))
        : select(c.freeze, select(progress.read().lt(steps), progress.read().add(1), i32(steps)),
          select(progress.read().gt(0), progress.read().sub(1), i32(0)));
      progress.write(select(c.reset, i32(0), next));
      const amount = f64(progress.read()).div(steps);
      const excitation = f64(1).sub(amount);
      // Materialize every outgoing sample before any buffer write. Integer
      // cursors avoid the fractional seconds/interpolation of delayReadhead.
      for (const line of lines) {
        line.wet.write(select(c.reset.or(line.valid.read().lt(line.size)), f64(0), line.history.read(line.cursor.read())));
      }
      const returns = lines.map(line => line.wet.read().mul(amount.add(excitation.mul(line.gain))));
      const left = select(c.reset, f64(0), f64(inputLeft).mul(SCALE).mul(excitation));
      const right = select(c.reset, f64(0), f64(inputRight).mul(SCALE).mul(excitation));
      for (let row = 0; row < lines.length; row++) {
        const line = lines[row];
        const feedback = returns.reduce((sum, value, column) => sum.add(value.mul(ROWS[row][column] * 0.5)), f64(0));
        const injection = left.add(right.mul(ROWS[1][row])).mul(0.5);
        line.history.write(select(c.reset, i32(0), line.cursor.read()), injection.add(feedback));
        line.cursor.write(select(c.reset, i32(0), select(line.cursor.read().eq(line.size - 1), i32(0), line.cursor.read().add(1))));
        line.valid.write(select(c.reset, i32(0), select(line.valid.read().lt(line.size), line.valid.read().add(1), i32(line.size))));
      }
      const output = (row: number) => f32(lines.reduce((sum, line, column) => sum.add(line.wet.read().mul(ROWS[row][column] * 0.5)), f64(0)).div(SCALE));
      return { left: output(2), right: output(3), freezeAmount: f32(amount), frozen: progress.read().eq(steps) };
    },
  };
});
