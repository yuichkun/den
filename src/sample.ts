import { bool, defineSubgraph, f32, f64, i32, instantiate, select, state, type Node, type TypedArrayFieldRef } from '@unworklet/core';

// Native floating scalar stores flush magnitudes below 1e-30. Exact binary
// scaling preserves meaningful subnormal control/position contributions.
const CONTROL_SCALE = 2 ** 128;
const READ_POSITION_SCALE = 2 ** 192;

export interface ResidentSampleConfig {
  /** Fixed mono PCM capacity, 1..65,536 frames; decoding/file I/O run outside the processor. */
  capacity: number;
  sourceSampleRate: number;
}
export interface ResidentSample {
  readonly capacity: number;
  readonly sourceSampleRate: number;
  /** Call in event<{data:Float32Array}>.onReceive. Copy runs at the block boundary.
   * Prepare/decode outside the callback and load before audible use. Oversize input
   * truncates to capacity; empty input unloads. Each load invalidates current playback. */
  load(data: TypedArrayFieldRef<'f32'>): void;
  length(): Node<'i32'>;
  revision(): Node<'i32'>;
  /** Linear interpolation; end is exclusive and clipped to loaded length.
   * NaN position uses start; other positions saturate to the signed i32 frame range. */
  read(position: Node<'f64'>, start: Node<'i32'>, end: Node<'i32'>, loop: boolean): Node<'f32'>;
}
function sampleRate(rate: number) {
  if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) throw new RangeError('sample rate must be in [8000,192000] Hz');
}
function integer(value: number, minimum: number, maximum: number, name: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be an integer in [${minimum},${maximum}]`);
}
function bounded(value: Node<'f32'>, minimum: number, maximum: number, fallback = 0) {
  return select(value.eq(value), f64(value), f64(fallback)).clamp(minimum, maximum);
}
function wrap(position: Node<'f64'>, start: Node<'i32'>, end: Node<'i32'>) {
  const length = f64(end.sub(start).max(1));
  const relative = position.sub(f64(start));
  return relative.sub(relative.div(length).floor().mul(length)).add(f64(start));
}

/** A fixed-capacity mono sample, initially missing. No asset loader or streaming. */
export const residentSample = defineSubgraph((config: ResidentSampleConfig): ResidentSample => {
  integer(config.capacity, 1, 65536, 'sample capacity'); sampleRate(config.sourceSampleRate);
  const pcm = state.buffer.f32({ size: config.capacity }).expose({ name: 'pcm', snapshot: 'persistent' });
  const length = state.i32(0).named('length'), revision = state.i32(0).named('revision');
  // A native transient scalar captures normalization once per read, including
  // when several independent readers share this resident in the same sample.
  const readPosition = state.f64(0).expose({ name: 'readPosition', snapshot: 'transient' });
  return {
    capacity: config.capacity, sourceSampleRate: config.sourceSampleRate,
    load(data) { pcm.copyFrom(data); length.write(data.length.clamp(0, config.capacity)); revision.write(revision.read().add(1)); },
    length() { return length.read(); }, revision() { return revision.read(); },
    read(position, start, end, loop) {
      const lo = start.clamp(0, config.capacity - 1), hi = end.clamp(0, config.capacity).min(length.read());
      const valid = hi.gt(lo);
      const safePosition = select(position.eq(position), position, f64(lo)).clamp(-2147483648, 2147483647);
      readPosition.write((loop ? wrap(safePosition, lo, hi) : safePosition.clamp(f64(lo), f64(hi.sub(1).max(lo)))).mul(READ_POSITION_SCALE));
      const p = readPosition.read().div(READ_POSITION_SCALE);
      const whole = i32(p.floor()).clamp(0, config.capacity - 1), fraction = p.sub(f64(whole));
      const next = loop ? select(whole.add(1).gte(hi), lo, whole.add(1)) : whole.add(1).min(hi.sub(1).max(lo));
      const rawA = f64(pcm.read(whole)), rawB = f64(pcm.read(next.clamp(0, config.capacity - 1)));
      // Invalid PCM taps are silent, without poisoning adjacent finite samples/state.
      const a = select(rawA.eq(rawA).and(rawA.abs().lte(3.4028234663852886e38)), rawA, f64(0));
      const b = select(rawB.eq(rawB).and(rawB.abs().lte(3.4028234663852886e38)), rawB, f64(0));
      return select(valid, f32(a.add(b.sub(a).mul(fraction))), f32(0));
    },
  };
});

export interface SamplePlayerConfig {
  sampleRate: number;
  sample: ResidentSample;
  /** Fixed slice [startFrame,endFrame), intersected with the current asset length. */
  startFrame?: number;
  endFrame?: number;
  loop?: boolean;
  /** Linear gate-off ramp in output samples; zero stops immediately. */
  releaseFrames?: number;
}
export interface SamplePlayerControls {
  gate: Node<'bool'>;
  /** Level-sensitive restart; a held trigger repeats the first sample. */
  trigger: Node<'bool'>;
  /** Priority over gate/trigger; held reset is silent. */
  reset: Node<'bool'>;
  /** Signed speed, [-16,16]; source/host sample-rate conversion is automatic. */
  rate: Node<'f32'>;
}

/** Mono, one voice, one-shot or loop; nearest endpoints with linear interpolation. */
export const samplePlayer = defineSubgraph((config: SamplePlayerConfig) => {
  sampleRate(config.sampleRate);
  const { sample, startFrame = 0, endFrame = sample.capacity, loop = false, releaseFrames = 0 } = config;
  integer(startFrame, 0, sample.capacity - 1, 'startFrame'); integer(endFrame, startFrame + 1, sample.capacity, 'endFrame');
  integer(releaseFrames, 0, Math.ceil(config.sampleRate * 10), 'releaseFrames');
  const phase = state.f64(startFrame * CONTROL_SCALE).named('phase'), active = state.bool(false).named('active');
  const previousGate = state.bool(false).named('previousGate'), revision = state.i32(-1).named('revision');
  const remaining = state.i32(0).named('releaseRemaining');
  return {
    tick(c: SamplePlayerControls) {
      const end = sample.length().min(endFrame), start = i32(startFrame), available = end.gt(start);
      const speed = bounded(c.rate, -16, 16).mul(sample.sourceSampleRate / config.sampleRate);
      const changed = sample.revision().eq(revision.read()).not();
      const trigger = c.trigger.or(c.gate.and(previousGate.read().not())).and(c.gate).and(c.reset.not()).and(available);
      const alive = select(trigger, bool(true), active.read().and(changed.not())).and(c.reset.not()).and(available);
      const initial = select(speed.lt(0), f64(end.sub(1)), f64(start));
      phase.write(select(trigger, initial, phase.read().div(CONTROL_SCALE)).mul(CONTROL_SCALE));
      const position = phase.read().div(CONTROL_SCALE);
      const releaseLeft = select(trigger, i32(releaseFrames), select(c.gate, remaining.read(), remaining.read().sub(1).max(0)));
      const level = releaseFrames > 0 ? f64(releaseLeft).div(releaseFrames) : select(c.gate, f64(1), f64(0));
      active.write(alive.and(level.gt(0)));
      const playing = active.read();
      const output = select(playing, f32(f64(sample.read(position, start, end, loop)).mul(level)), f32(0));
      const advanced = position.add(speed);
      phase.write(select(c.reset, f64(startFrame), loop ? wrap(advanced, start, end) : advanced.clamp(f64(start).sub(1), f64(end))).mul(CONTROL_SCALE));
      active.write(playing.and(loop ? bool(true) : advanced.gte(f64(start)).and(advanced.lt(f64(end)))));
      remaining.write(select(playing, releaseLeft, i32(0))); previousGate.write(c.gate.and(c.reset.not())); revision.write(sample.revision());
      return { output, active: playing, position: f32(position), missing: available.not() };
    },
  };
});

export interface SampleZone {
  sample: ResidentSample;
  keyLow: number; keyHigh: number;
  /** Inclusive normalized velocity endpoints. First matching zone wins overlaps. */
  velocityLow: number; velocityHigh: number;
  rootKey: number;
  tuneCents?: number;
  gain?: number;
  startFrame?: number; endFrame?: number; loop?: boolean;
}
export interface MultisampleConfig { sampleRate: number; zones: readonly SampleZone[]; releaseFrames?: number }
export interface MultisampleControls {
  key: Node<'f32'>; velocity: Node<'f32'>; gate: Node<'bool'>; trigger: Node<'bool'>; reset: Node<'bool'>;
  /** Additional signed ratio, multiplied after root-key transposition; final ratio clips to ±16. */
  rate: Node<'f32'>;
}
// Core 0.4.1 pow uses a shared f32 approximation even for f64 operands.
// Reduce the bounded pitch exponent to [0,1), evaluate exp(x*ln2) in f64,
// and scale by exact powers of two. This avoids pitch drift from that bridge.
function transposeRatio(exponent: Node<'f64'>) {
  const whole = exponent.floor(), x = exponent.sub(whole).mul(Math.LN2);
  let factorial = 1;
  const coefficients = [1];
  for (let n = 1; n <= 12; n++) { factorial *= n; coefficients.push(1 / factorial); }
  let polynomial = f64(coefficients[12]);
  for (let n = 11; n >= 0; n--) polynomial = polynomial.mul(x).add(coefficients[n]);
  const index = i32(whole.add(13));
  let scale = f64(2 ** -13);
  for (let bit = 0; bit < 5; bit++) scale = scale.mul(select(index.div(2 ** bit).mod(2).eq(1), f64(2 ** (2 ** bit)), f64(1)));
  return polynomial.mul(scale);
}

/** Monophonic key/velocity selection; zone/key/velocity latch on note-on. */
export const multisamplePlayer = defineSubgraph((config: MultisampleConfig) => {
  sampleRate(config.sampleRate); integer(config.zones.length, 1, 16, 'zone count');
  const zones = config.zones.map((zone, index) => {
    integer(zone.keyLow, 0, 127, 'keyLow'); integer(zone.keyHigh, zone.keyLow, 127, 'keyHigh'); integer(zone.rootKey, 0, 127, 'rootKey');
    const { velocityLow: low, velocityHigh: high, tuneCents = 0, gain = 1 } = zone;
    if (!Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high > 1 || high < low || !Number.isFinite(tuneCents) || Math.abs(tuneCents) > 2400 || !Number.isFinite(gain) || Math.abs(gain) > 4) throw new RangeError('invalid velocity zone, tuning or gain');
    return { ...zone, tuneCents, gain, transposition: state.f64(1).named(`zone${index}Transposition`), player: instantiate(samplePlayer, { ...zone, sampleRate: config.sampleRate, releaseFrames: config.releaseFrames }, { name: `zone${index}` }) };
  });
  const selected = state.i32(-1).named('selected'), lastGate = state.bool(false).named('previousGate');
  const keyState = state.f64(60 * CONTROL_SCALE).named('key'), velocityState = state.f64(0).named('velocity');
  const noteOn = state.bool(false).named('noteOn');
  return { tick(c: MultisampleControls) {
    const key = bounded(c.key, 0, 127, 60), velocity = bounded(c.velocity, 0, 1);
    noteOn.write(c.trigger.or(c.gate.and(lastGate.read().not())).and(c.gate).and(c.reset.not()));
    const start = noteOn.read();
    let match = i32(-1);
    for (let index = zones.length - 1; index >= 0; index--) {
      const z = zones[index];
      match = select(key.gte(z.keyLow).and(key.lte(z.keyHigh)).and(velocity.gte(z.velocityLow)).and(velocity.lte(z.velocityHigh)), i32(index), match);
    }
    selected.write(select(c.reset, i32(-1), select(start, match, selected.read())));
    const current = selected.read();
    keyState.write(select(start, key.mul(CONTROL_SCALE), keyState.read()));
    velocityState.write(select(start, velocity.mul(CONTROL_SCALE), velocityState.read()));
    // Native state reads materialize latched controls before the unrolled bank.
    const note = keyState.read().div(CONTROL_SCALE), level = velocityState.read().div(CONTROL_SCALE);
    let sum = f64(0), active = bool(false), missing = current.lt(0);
    zones.forEach((z, index) => {
      const chosen = current.eq(index);
      // Materialize the latched ratio once. Repeating the polynomial graph inside
      // every readhead expression causes excessive capture/compiler expansion.
      z.transposition.write(select(start, transposeRatio(note.sub(z.rootKey).div(12).add(z.tuneCents / 1200)), z.transposition.read()));
      const ratio = z.transposition.read().mul(bounded(c.rate, -16, 16));
      const result = z.player.tick({ gate: c.gate.and(chosen), trigger: start.and(chosen), reset: c.reset.or(start.and(chosen.not())), rate: f32(ratio) });
      sum = sum.add(f64(result.output).mul(level).mul(z.gain)); active = active.or(result.active); missing = missing.or(chosen.and(result.missing));
    });
    lastGate.write(c.gate.and(c.reset.not()));
    return { output: f32(sum), active, zoneIndex: current, missing };
  } };
});

export interface GranularConfig { sampleRate: number; sample: ResidentSample; maxGrains: number; seed?: number; loop?: boolean }
export interface GranularControls {
  gate: Node<'bool'>; reset: Node<'bool'>;
  positionFrames: Node<'f32'>; jitterFrames: Node<'f32'>;
  rate: Node<'f32'>;
  durationSeconds: Node<'f32'>;
  /** 0..2000 onsets/second. Gate-rise creates the first grain even at zero density. */
  densityHz: Node<'f32'>;
}
/** Fixed grain pool, triangular endpoint-zero windows; first free slot, drop on full. */
export const granularSource = defineSubgraph((config: GranularConfig) => {
  sampleRate(config.sampleRate); integer(config.maxGrains, 1, 32, 'maxGrains');
  const { sample, maxGrains, seed = 1, loop = true } = config;
  integer(seed, 1, 2147483646, 'grain seed');
  const random = state.i32(seed).named('random'), clock = state.f64(0).named('clock');
  const allocatedState = state.bool(false).named('allocated'), onsetState = state.bool(false).named('onset');
  const onsetPosition = state.f64(0).named('onsetPosition'), onsetSpeed = state.f64(0).named('onsetSpeed');
  const onsetDuration = state.i32(3).named('onsetDuration');
  const lastGate = state.bool(false).named('previousGate'), revision = state.i32(-1).named('revision');
  const grains = Array.from({ length: maxGrains }, (_, index) => ({
    position: state.f64(0).named(`grain${index}Position`), age: state.i32(0).named(`grain${index}Age`),
    duration: state.i32(3).named(`grain${index}Duration`), speed: state.f64(0).named(`grain${index}Speed`),
    active: state.bool(false).named(`grain${index}Active`),
  }));
  return { tick(c: GranularControls) {
    const changed = sample.revision().eq(revision.read()).not(), clear = c.reset.or(changed);
    const rising = c.gate.and(lastGate.read().not());
    const phase = select(clear.or(rising), f64(0), clock.read().div(CONTROL_SCALE));
    onsetState.write(c.gate.and(c.reset.not()).and(sample.length().gt(0)).and(rising.or(phase.gte(1))));
    const onset = onsetState.read();
    const rng = select(c.reset, i32(seed), random.read());
    const nextRandom = i32(f64(rng).mul(48271).mod(2147483647));
    random.write(select(onset, nextRandom, rng));
    const jitter = f64(random.read()).div(2147483647).mul(2).sub(1).mul(bounded(c.jitterFrames, 0, sample.capacity - 1));
    onsetPosition.write(bounded(c.positionFrames, 0, sample.capacity - 1).add(jitter).clamp(0, f64(sample.length().sub(1).max(0))).mul(CONTROL_SCALE));
    onsetDuration.write(i32(bounded(c.durationSeconds, 0, 2).mul(config.sampleRate).add(0.5).floor()).clamp(3, Math.round(config.sampleRate * 2)));
    onsetSpeed.write(bounded(c.rate, -16, 16).mul(sample.sourceSampleRate / config.sampleRate).mul(CONTROL_SCALE));
    const center = onsetPosition.read().div(CONTROL_SCALE), duration = onsetDuration.read(), speed = onsetSpeed.read().div(CONTROL_SCALE);
    allocatedState.write(false);
    let sum = f64(0), count = i32(0);
    for (const grain of grains) {
      const existing = grain.active.read().and(grain.age.read().lt(grain.duration.read())).and(clear.not());
      // Keep the first-free scan linear in graph size as well as runtime work.
      const allocated = allocatedState.read();
      const launch = onset.and(allocated.not()).and(existing.not()); allocatedState.write(allocated.or(launch));
      grain.active.write(existing.or(launch));
      grain.age.write(select(launch, i32(0), grain.age.read()));
      grain.duration.write(select(launch, duration, grain.duration.read()));
      grain.position.write(select(launch, center.mul(CONTROL_SCALE), grain.position.read()));
      grain.speed.write(select(launch, speed.mul(CONTROL_SCALE), grain.speed.read()));
      const active = grain.active.read(), age = grain.age.read(), length = grain.duration.read();
      const position = grain.position.read().div(CONTROL_SCALE), step = grain.speed.read().div(CONTROL_SCALE);
      const window = f64(1).sub(f64(age).div(f64(length.sub(1))).mul(2).sub(1).abs()).max(0);
      const inBounds = position.gte(0).and(position.lt(f64(sample.length())));
      const value = sample.read(position, i32(0), sample.length(), loop);
      sum = sum.add(select(active.and(loop ? bool(true) : inBounds), f64(value).mul(window), f64(0))); count = count.add(select(active, i32(1), i32(0)));
      grain.position.write((loop ? wrap(position.add(step), i32(0), sample.length()) : position.add(step).clamp(-sample.capacity * 48, sample.capacity * 48)).mul(CONTROL_SCALE));
      grain.age.write(select(active, age.add(1), i32(0))); grain.active.write(active.and(age.add(1).lt(length)));
    }
    clock.write(select(c.gate.and(c.reset.not()), phase.sub(phase.floor()).add(bounded(c.densityHz, 0, 2000).div(config.sampleRate)), f64(0)).mul(CONTROL_SCALE));
    lastGate.write(c.gate.and(c.reset.not())); revision.write(sample.revision());
    return { output: f32(sum.div(maxGrains)), activeGrains: count, onset, dropped: onset.and(allocatedState.read().not()), missing: sample.length().eq(0) };
  } };
});
