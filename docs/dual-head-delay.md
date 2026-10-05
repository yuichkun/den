# Dual-head delay-time transitions — candidate contract

`dualHeadDelay` at `@denaudio/den/dual-head-delay` is an additive mono delay
primitive. The initial `delayReadhead`, Delay/Chorus, tempo policy and existing
sounds are unchanged. This candidate supports bounded delay-time transitions by
crossfading two fixed delay offsets. It is not a pitch shifter or time stretcher.

## API and construction

```ts
const delay = instantiate(dualHeadDelay, {
  sampleRate: ctx.sampleRate,
  maxDelaySeconds: 2,
  transitionSamples: 256,
}, { name: 'transitionDelay' });
// Exactly once per sample:
const { output, transitioning, timingRejected } = delay.tick(input, timeSeconds, reset);
```

For same-sample feedback or processing before history is written:

```ts
const tap = delay.read(timeSeconds, reset);
tap.write(input.add(tap.output.mul(0.5)));
output.write(tap.output);
```

Use exactly one `tick`, or one `read` followed by one call to that read's `write`,
per sample per instance. The object and closure exist at graph construction only.
No allocation occurs on the audio thread. Audio and seconds are f32 nodes; reset
and both diagnostics are boolean nodes. Input audio must be finite. No parameter,
state, routing or loader framework is introduced; use native unworklet 0.4.1 APIs.

Construction requires integer `sampleRate` in 8000..192000, matching the enclosing
processor, capacity from one sample through eight seconds (default two seconds),
and integer `transitionSamples` in 2..65536 (default 256). These are tested candidate
implementation bounds, not general product or real-time capacity claims. Allocation
is one fixed f64 history of `ceil(sampleRate * maxDelaySeconds) + 2` values, plus
scalar state. At the maximum eight seconds/192 kHz this is 1,536,002 history
values, or 12,288,016 history bytes. The measured packed four-output fixture uses
12,320,768 bytes of native WASM memory at that capacity, unchanged across its
allocation/tiny-signal smoke. There is no resize or dynamic per-request buffer.

## Timing and rapid requests

Times are accepted within the f32-representable endpoints
`[f32(1/sampleRate), f32(maxDelaySeconds)]`. Conversion to sample offset uses f64,
with only endpoint rounding clamped to the exact capacity. Invalid finite times,
NaN and infinities are rejected, `timingRejected=true`, and the last valid request
is retained. They do not silently replace an unavailable musical time with a
clamped rhythm. A fresh or reset instance with an invalid time starts at one sample.

The first sample, and every reset sample, captures the valid current request
immediately, without a startup fade. Later distinct accepted delays start a fade
only when the previous fade is finished. For a transition starting at sample `s`
with length `L`, the current output is

`(1 - a) * x[n - oldDelay] + a * x[n - newDelay]`,
where `a = (n - s)/(L - 1)` for `s <= n < s + L`.

The request sample is old-only; sample `s+L-1` is new-only. Both delay offsets stay
fixed for that whole fade. `transitioning` is true on all L samples, including
both endpoints. An unchanged accepted delay causes no fade. A change while fading
updates a single latest-valid-request slot; it never moves either active head,
interrupts the fade, or starts a third head. After the fade ends, the most recent
accepted request starts another fade on the next sample if it differs from the
settled target. A request back to the old delay therefore completes the outward
fade before returning. A request back to the active target removes a stale queued
request. Invalid requests leave this queue alone. This bounded coalescing policy
can skip intermediate automation values.

An idle change reaches its requested endpoint L-1 samples after its request. A
request during an existing fade may wait for that fade and a second full fade;
newer requests may supersede it. Continuous modulation has no exact tracking or
uniform control-latency guarantee. This is a control transition duration, not an
additional audio lookahead delay. Audio is always read before the current input
is written, so the minimum audio delay is one sample; there is no zero-delay dry
feedthrough.

## Interpolation, gain, phase and tails

Each fixed head linearly interpolates its two adjacent source samples. For offset
`k+f`, this is `(1-f)*x[n-k] + f*x[n-k-1]`. The interpolation response is
`(1-f)+f*exp(-j*w)` apart from integer delay; the half-sample case reaches zero at
Nyquist. The transition is a linear amplitude crossfade rather than equal power.
All four source weights are nonnegative and sum to one, so finite input extrema
are not exceeded by this primitive. Correlated in-phase heads retain unity gain;
uncorrelated heads dip in energy at the midpoint, and opposite-phase heads can
cancel. The two times can create comb filtering, transient smearing, duplicated
or skipped content, and modulation sidebands. A sine maintains its original
frequency at each fixed head, but the overlapping signal need not maintain its
amplitude or phase during a transition. No arbitrary-modulation Doppler-free,
antialiasing, click-free, seamless or ideal pitch-preservation claim is made.

There is no internal feedback, dry/wet, bypass, limiter or gain compensation.
Callers compose those explicitly. An undelayed dry mix combs against the wet delay;
both branches have no implicit alignment. Convex dry/wet preserves the primitive's
input peak bound. Feedback changes that bound: for a constant magnitude feedback
below one, the history can be bounded by inputPeak/(1-abs(feedback)); external
filtering, gain, clipping and modulation are the caller's responsibility. The
read-before-write API adds no extra circulation sample beyond the selected delay.

Stopping input lets stored source samples finish. Without feedback, no stored
contribution survives beyond `ceil(sampleRate*maxDelaySeconds)` samples after the
last nonzero input, even through requests. A transition can expose earlier history
or spread an impulse across both heads, so its tail is not a single echo. External
feedback extends the tail. Reset cancels transitions and logically invalidates all
prior history before the read; the current input is then the first new sample.
Held reset remains silent. Reset can click and is not a bypass or memory-erasure API.

## Numerical state and verification boundary

History is multiplied by exact `2**128` before f64 storage and divided after the
weighted read. This avoids native buffer scrubbing of tiny valid f32 samples and
keeps full-range finite f32 weighted sums inside f64. It does not recover a result
below f32's representable range. Stable named state records history, cursor, valid
count, initialized state, current/target/queued delays and remaining fade samples.
Snapshot continuation requires the same schema, sample rate, capacity and fade
length. Logical reset does not physically wipe old snapshot bytes.

The dedicated tests compare native rendering with an independent unbounded source
timeline and absolute-time transition schedule, plus analytic impulse, sinusoidal,
phase/cancellation and feedback assertions. They cover rapid changes, invalid
controls, minimum/maximum and fractional wraps, reset, instance isolation,
full-range and tiny finite audio, and in-flight snapshot continuation at 44.1/48/96
kHz. The isolated packed consumer uses the public subpath, strict declarations,
native parameter edits and actual rendering. Audio remains CANDIDATE, not an
approved golden. Local cost reports are diagnostic only: an initial 96 kHz run observed a
4.655 ms warm quantum against a 1.333 ms nominal budget. Host jitter and cold
execution are not hidden by median timings. No browser, hardware
real-time deadline, general pitch/time processing or listening approval follows.
