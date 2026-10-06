# Musical controls candidate contract

This bounded additive lane defines `@denaudio/den/musical-controls`, with
`curvedAdsr` and `musicalLfo`. Existing envelope, LFO, clock, and MSEG entries stay
compatible. Package export wiring belongs to the integration owner. This document
records the independently reviewed entry contract; execution evidence is separate.

Both graphs use fixed state, instantiate once, and tick exactly once per sample.
Sample rate is an integer in [8000,192000]. All dynamic numeric inputs are finite
f32 values; NaN and infinity are outside this contract. Sample-rate/configuration changes
require reconstruction; same-schema snapshots at the same configuration resume
exactly. No routing, scheduler, MIDI/MPE/RPN, parameter, snapshot, or clock framework
is added. Generated output remains CANDIDATE; runtime is NOT_CLEARED.

## Curved ADSR

`curvedAdsr({ sampleRate }).tick({ gate, retrigger, reset, attack, decay, sustain,
release, attackBend, decayBend, releaseBend }) -> { level, done }`.

Gate/retrigger/reset are bool nodes; all other inputs and level are f32 nodes;
done is bool. Durations are seconds, clamped [0,30], then rounded to the nearest
sample with half samples up after the f32 input conversion. Sustain clamps [0,1].
Bends clamp [-1,1]. For a segment of N frames, step k uses t=k/N and
C(t,b)=t+b*t*(1-t). b=0 is linear, -1 is t² (ease-in), +1 is 2t-t² (ease-out).
The output is start+(target-start)*C(t,b), with exact endpoint assignment on step
N. This shapes segment time, preserving the latched sustain target and the
retrigger/release origin. It is not a post-warp of absolute ADSR amplitude.
Bend zero specifies a linear curve, not byte identity with the legacy iterative
envelope, because this module deliberately latches the last emitted f32 level.

- Stages are idle, attack, decay, sustain, release. Idle/reset output zero and
  done=true. Sustain, including sustain zero, has done=false.
- A gate rise or high retrigger while gate is high begins attack from the last
  emitted f32 level. Retrigger is level-sensitive; every high sample restarts.
- Positive N-frame stages emit step 1 on their entry sample and their endpoint
  on step N. Attack duration/bend latch on its entry. Decay duration/bend/target
  latch on the preceding positive attack endpoint, with its first step on the
  next sample. Release duration/bend latch on the gate-fall sample.
- Zero attack reaches 1 and immediately enters decay on the same sample. A zero
  decay then reaches sustain immediately. Zero decay following a positive attack
  reaches sustain on the next sample. Zero release becomes idle immediately.
- Gate-off wins over retrigger, releases from the last emitted level, and reaches
  exact zero/done on release step N. Release from zero becomes done immediately.
  A positive release origin can round to f32 zero before step N; that does not
  make done true early. Completion uses the latched segment, not rounded output.
- Reset wins over gate-off and retrigger, emits zero immediately, clears stage
  state, and consumes the current gate. A held gate after reset needs a new gate
  edge or retrigger. Held reset stays idle. Retrigger with gate=false is ignored.
- Duration, target, and bend edits do not change an active segment. Sustain stage
  follows the current clamped sustain input every sample. Such live sustain edits,
  zero durations, and reset can intentionally jump; no implicit smoothing exists.
- Segment state records exact i32 duration/elapsed values and scaled f64 start,
  target, bend, and last-emitted level. Power-of-two scaling protects tiny finite
  f32 values against core 0.4.1 scalar-state flushing. Output rounds to f32.

Independent numerical oracles use the algebraically different Bernstein
form C=(1+b)*t*(1-t)+t², closed-form event intervals, exact endpoint/done checks,
manual retrigger/release origins, zero-stage precedence, latching counterexamples,
maximum-duration sample probes, tiny controls, instance isolation, and identical
same-schema snapshot continuation at 44.1/48/96 kHz. Assertions distinguish absolute-level warping, wrong endpoints, and incorrect
latching from the specified behavior. The maximum-duration probes inspect the
first 383 steps and native latched duration; they do not render a full 30 seconds.

## Tempo/free multiwave LFO

`musicalLfo({ sampleRate, mode, waveform, beatsPerCycle? }).tick({ rate, reset,
seek, position, phaseOffset, hold }) -> { value, phase }`.

`mode` is fixed `free` or `tempo`; `waveform` is fixed `sine`, `triangle`, `saw`,
or `square`. `beatsPerCycle` defaults to 1 and accepts powers of two in [1/64,64]
only in tempo mode; free mode requires 1. Rate/position/phaseOffset and outputs
are f32; reset/seek/hold are bool.

The implementation composes the existing `musicalClock` with one step per cycle,
using stepsPerBeat=1/beatsPerCycle for tempo. Free rate is Hz clamped [0,20].
Tempo rate is BPM clamped [0,1000]; frequency is BPM/(60*beatsPerCycle), up to
1066 2/3 Hz at the smallest division. No frequency cap changes the tempo ratio.
That extreme is above conventional LFO rates; use appropriate rates for the
modulated destination. Position and phaseOffset are in cycles, each clamped to
[-1048576,1048576]. Position matters only on a rising seek edge. This module
inherits the existing clock's wrapping and the separately reviewed narrow repair
in `docs/musical-clock-seek-boundary.md`: a wrapped value that rounds up to the
cycle length is capped to its immediately preceding f64. Negative tiny seeks
therefore stay in the last step; exact signed integer seeks reach zero. No extra
f32 seek quantization is inserted before the clock.

- The initial base phase is zero. Output uses current phase before integrating
  this sample's rate. Changing rate preserves phase. Rate zero or hold=true stops
  base-phase integration; the live offset still affects the waveform.
- Reset pins the base phase to zero throughout a held reset and wins over seek.
  Reset consumes seek level; a seek held across reset release needs a fresh edge.
  Offset still applies while reset. The first reset-low sample emits base zero
  and resumes integration unless held or rate zero.
- Seek is rising-edge-sensitive, can move phase while held, and emits the sought
  phase on that sample. A held seek does not pin or repeatedly restart phase.
- The existing clock exposes a canonical f32 base phase (capped below 1). The
  offset first loses its integer part by truncation toward zero, preserving its
  signed fractional part. Shifted phase is wrap(f64(basePhase)+fractionalOffset),
  rounded to f32 and capped at 1-2^-24, with exactly one wrap after the addition.
  This preserves negative-tiny offsets at base zero as the upper capped phase;
  large integral offsets do not erase tiny base phases by f64 addition.
  Waveforms are evaluated at that public phase, deliberately retaining
  the existing clock's f32 quantization. Very slow changes may be inaudible or
  repeat while internal compensated/scaled clock state continues to advance.
  This module does not promise full-f64 waveform phase or sub-ULP edge timing.
- Sine: sin(2πp), using the bounded f64 polynomial already used by the legacy LFO.
  Triangle: 4p for p<1/4; 2-4p for 1/4<=p<3/4; 4p-4 otherwise.
  Saw: 2p-1. Square: +1 for p<1/2, -1 otherwise (50% duty, boundary is low).
  Output is f32 in [-1,1]. Saw and square have explicit discontinuities; all are
  naïve non-bandlimited waveforms, with no anti-aliasing or smoothing claims.
- Offset/seek/reset can intentionally jump. Hold freezes the clock, not changing
  offsets. No depth, destination-unit conversion, random waveform, or transport
  synchronization beyond caller-supplied BPM is included.

Independent oracles calculate phase from exact f32 input schedules or rational
sample-index expressions, apply the declared public f32 rounding, and compare
sine with Math.sin and other waves with independent piecewise formulas. Tests
cover all waves, free/tempo ratios, quarter/half/wrap boundaries, signed offsets,
phase seeks (including signed integer neighbors and a retained native raw-clock
negative-tiny counterexample), held controls/precedence, tempo changes without restart, tiny-rate
state survival despite public quantization, restore, bounds, and instance isolation
at 44.1/48/96 kHz. Packed and hosted-browser acceptance belong to integration.

## Verification boundary

`tests/musical-controls.spec.ts` performs native numerical and snapshot checks,
including 44.1/48/96 kHz control schedules and a 49,152-frame smallest-subnormal
free-rate probe at 48 kHz. The clock repair has its own independent all-capacity
regressions. Source typechecking is separate from packed-public-entry and hosted
browser proof; those integration checks are owned by the integration lane.
No human listening approval, approved golden, or runtime clearance is implied.

`tests/musical-controls-packed.test.mjs` packs the real package, installs it into
an isolated consumer with the pinned fixture lock, checks the actual public
TypeScript declarations, renders independent ADSR/LFO references at three rates,
and builds separate ADSR and four-wave LFO worklet/WASM artifacts. Its default
and CI path uses fresh `npm ci`. The explicit local-only
`DEN_MUSICAL_CONTROLS_REUSE_LOCKED_CONSUMER` alternative reuses an existing locked
dependency tree while extracting the newly packed target into a private directory;
it is rejected under CI and is not presented as fresh-install evidence. Reuse
records and rechecks the donor tarball, lock, installed target and full dependency
file identities. The native diagnostic includes input/output copies and reports
cold/startup/warm timing, zero memory growth and scrubbing, without runtime
clearance. Raw f32 evidence contains control signals, not an audio audition.
