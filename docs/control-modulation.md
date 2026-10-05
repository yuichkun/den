# Control modulation candidates

Catalog §5, additive `@denaudio/den/modulation` entry. Existing `envelope` and
`lfo` implementations and contracts are unchanged. These are graph-native fixed
state modules for instruments and FX, not a transport, routing layer, arbitrary
scheduler, MIDI framework, approved sound library, or real-time guarantee.

## Shared execution contract

Instantiate during graph construction, with an integer sample rate from 8,000
through 192,000 Hz where a rate is required. Call each instance's `tick` exactly
once per audio sample. All dynamic numeric inputs must be finite. Audio/event
rates are not silently smoothed or converted to control-block rates. Changing
sample rate requires reconstruction; same-schema snapshots continue an instance
at the same sample rate and construction settings. No cross-configuration or
cross-rate snapshot compatibility is claimed. Give independent instances distinct
unworklet names.

Construction checks reject nonfinite values, unsupported modes, invalid bounds,
or capacities. Fixed capacities are at most 16 MSEG segments and 64 sequence
steps. Arrays are copied at construction; no dynamic graph/buffer growth occurs.

Scalar histories that can contain tiny f32 controls use exact power-of-two f64
scaling. This avoids core 0.4.1's tiny scalar-state write flush without introducing
a control dead zone. Sample-and-hold preserves the entire finite f32 input range,
including subnormals and values above full scale.

## Musical clock

`musicalClock({ sampleRate, mode, steps, stepsPerBeat? })` exposes
`tick({ rate, reset, seek, position }) -> { step, phase, tick }`.

- `mode` is `free` or `tempo`; `steps` is a fixed integer 1..64.
- Free `rate` is steps per second. Tempo `rate` is BPM. Both clamp to [0,1000].
- Tempo `stepsPerBeat` defaults to 1 and accepts powers of two from 1/64 to 64.
  Free mode requires the default 1. Thus the maximum step rate is below the
  minimum sample rate and at most one boundary can occur per sample.
- `step` is an integer-valued f32 in [0,steps); `phase` is an f32 fraction in
  [0,1), capped at the largest f32 below 1 to keep the public range exact.
- Output describes the current sample before integrating its rate. The initial
  sample ticks, even at rate zero. Subsequent zero rate holds the current phase.
- Rate changes preserve phase. The sample receiving a new rate uses that rate
  for the next sample's phase. A pending boundary tick remains observable if
  the new rate becomes zero on the boundary sample.
- Held `reset` pins step/phase to zero and suppresses all ticks. The first
  reset-low sample emits the start tick and starts integrating again.
- `seek` applies only on its rising edge. Held seek does not freeze phase or
  retrigger. `position` is in steps, explicitly clamped to [-1048576,1048576],
  then wrapped to [0,steps). Negative positions wrap backward. A seek emits a
  tick on that sample, including a seek into the middle of a step.
- Reset wins over seek and consumes the seek level. A seek held across reset
  release needs another low→high edge to take effect.

Internal phase uses compensated f64 accumulation in frequency units. It avoids
rounding a noninteger samples-per-step period and divides only for phase output.
There is no growing global position counter or global duration limit. This is a
numerical design, not a proof of perpetual drift-free behavior: the accompanying
tests compare measured boundary samples against independent schedules at
44.1/48/96 kHz, with documented observation lengths.

## Fixed step sequence

`stepSequence({ sampleRate, mode, stepsPerBeat?, steps })` accepts 1..64 fixed
`{ value, gate }` entries. Values are [-1,1], gate fractions [0,1]. Its `tick`
uses the clock controls and returns `{ value, gate, step, phase, tick }`.

Value changes exactly with step selection. Gate is true while the internal f64
phase is strictly less than the selected gate fraction: zero never opens and one
stays open for the whole step. Reset always gates off but exposes step zero's
value. Release opens the gate according to the first step. Tempo/free zero holds
a currently open gate; callers wanting a stop must use reset. Adjacent gate-one
steps can stay continuously high, while `tick` still identifies step starts.
Gate decisions use f64 phase, not the rounded public f32 phase. No interpolation,
swing, arbitrary ordering, note allocation, or implicit smoothing is provided.

## MSEG

`mseg({ sampleRate, initial, segments, loop? })` accepts `initial` and segment
`target` values in [-1,1], and 1..16 `{ seconds, target, curve }` entries.
Durations are fixed at construction, in [0,30] seconds, rounded to the nearest
sample with half-samples rounded up. Curves on normalized segment time t are:

- `linear`: t
- `easeIn`: t²
- `easeOut`: 2t−t²
- `smoothstep`: 3t²−2t³

`tick({ trigger, reset })` returns `{ value, done, segment }`. A rising trigger
starts from `initial`, emitting step 1 on that sample. A positive N-sample segment
reaches its target on step N. A held trigger does not retrigger. A new rising
trigger restarts from initial even while already running, intentionally permitting
a jump. Reset wins, consumes the trigger level, emits initial, and sets done.
Idle segment is zero; active segment is an integer-valued f32 list index.

Zero-duration segments collapse at their exact boundary in list order, including
those after a positive segment's endpoint; the last coincident zero segment wins.
A nonlooping all-zero MSEG reaches its last target and becomes done on its trigger
sample. Otherwise done becomes true on the final endpoint sample and the final
value remains held. No threshold tail detection is used.

Whole-envelope looping emits the final endpoint before the next iteration's
first step. It can jump when the final target differs from initial. There is no
implicit crossfade or smoothing. An all-zero loop is rejected. This first version
does not add sustain-point, release-segment, partial-loop, or runtime duration
editing semantics.

## Sample-and-hold and correlated random

`sampleAndHold({ initial })` has `tick(input, trigger, reset)`. Initial is bounded
to [-1,1], but sampled input is any finite f32. Trigger is level-sensitive: each
high sample stores that sample's input. Low trigger holds finite f32 numeric values; the native scalar-state write
canonicalizes negative zero to positive zero. All nonzero finite values, including
subnormals, remain bit-exact. Reset wins, restores initial, and holds it throughout a held reset.

`randomModulator({ seed, initial })` has
`tick({ trigger, reset, correlation })`. Seed is an integer 1..2147483646;
initial is [-1,1]. On every high trigger it advances the Park–Miller recurrence
`s = (16807*s) mod 2147483647` using exactly represented f64 integers, maps
`u = 2*(s−1)/2147483645−1`, then outputs
`correlation*previous + (1−correlation)*u`. Correlation clamps to [0,1].

Zero correlation is seeded uniform S&H. Positive correlation makes a bounded
first-order correlated sequence. One holds the value but still advances the seed;
returning to zero therefore resumes at the advanced random position. Reset
restores both seed and initial, with no PRNG advance even if trigger is high.
Independent instances do not share random state. No cryptographic suitability,
Gaussian distribution, variance normalization, target spectral color, or sound
quality equivalence is claimed.

## Evidence and limits

`tests/control-modulation.spec.ts` uses independent closed-form curves, exact
BigInt PRNG arithmetic, sample-index timing schedules, boundary/held-control
checks, seed isolation, snapshots, and bounds. The packed consumer installs the
actual tarball using its pinned npm lock, imports only the public entry, typechecks
strictly, compiles and renders actual DSP at 44.1/48/96 kHz, and checks zero scrub.
Any emitted evidence is CANDIDATE. No new human-approved golden or browser/hardware
real-time claim is made.

The native MIDI probe in `tests/probes/control-midi-output.mjs` verifies offline
note-on/off at samples 127/128 when explicit absolute `atSample` is supplied.
This is only a native emitted-event entry proof. Browser bridge, WebMIDI device,
and external host delivery are not verified. An output declaration alone is not
host integration proof. The bounded arp below builds only on the proven native
emitted-event path.


## Fixed-note arpeggiator candidate

`fixedArpeggiator({ sampleRate, mode, stepsPerBeat?, channel, notes })` accepts a
fixed list of 1..64 `{ note, velocity, gate }` entries. Channel is an integer
0..15, note 0..127, velocity 1..127, gate fraction [0,1]. The list plays in its
specified order. It does not capture incoming chords, allocate voices, alter
transport, or add another MIDI queue.

`tick(output, { rate, reset, seek, position, atSample })` receives a native
`MidiOutputHandle` created by `event.midi({ to: 'main', ... })`. It returns
`{ note, gate, step, phase, tick }` and conditionally emits native note events.
The clock/reset/seek contracts above apply unchanged.

- Gate zero is a rest and never produces a note-on.
- At each step-start tick, an existing note is turned off before the new note
  is turned on, even for repeated pitches and gate-one adjacent steps.
- When the selected gate closes, the active note is turned off once.
- Seeking turns the old note off first; it starts the new note only if the
  seeked phase lies within that step's gate. A held seek does not retrigger.
- Reset turns the active note off once, suppresses starts while held, and
  starts step zero on reset release if that step is not a rest.
- Rate zero holds phase and any active note. Send reset and process that sample
  before stopping/disconnecting. This module cannot guarantee a note-off after
  the host abruptly stops calling it, loses queued events, or loses a device.
- The caller supplies the absolute `atSample` timestamp as a `Node<'i32'>`
  containing native unsigned 32-bit timestamp bits. The native reader interprets
  the bits unsigned: the signed 2^31 boundary is preserved, and 2^32 wraps to 0.
  This is the native format limit, not an indefinitely monotonic timestamp API.
  Caller and host own epoch/transport interpretation. The module does not add
  a global timestamp counter or another transport. No implicit lookahead exists.
- At most one off plus one on can be emitted by this producer on any sample.
  A dedicated output capacity of at least 256 covers the conservative two-event
  bound for a 128-sample quantum when drained every quantum. Native tests verify
  all 256 slots are usable. This is not a lossless guarantee if the host stops
  draining or additional producers share that ring. Native overflow drops the
  oldest event, which can lose a note-off; host diagnostics and lifecycle matter.
- Same-schema snapshot continuation is demonstrated only when the external MIDI
  recipient has the matching note state. Restoring a DSP snapshot into an empty
  or different MIDI device state does not reconstruct that device's notes.

`tests/control-arpeggiator.spec.ts` checks actual native event payloads/order,
zero/full gates, reset/seek/tempo changes, stopped-rate hold, reset-before-stop,
repeated pitches, same-schema continuation, signed timestamp crossing and uint32
wrap at 44.1/48/96 kHz. A bounded burst test proves 256 usable native ring slots
and retains an undersized-128 counterexample that loses the first half of the
burst. These are offline native-event tests; browser bridge, WebMIDI devices,
external host delivery and human musical approval remain unverified.
