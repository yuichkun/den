# Bounded frequency shifter candidate

`@denaudio/den/frequency-shifter` exports `frequencyShifter`,
`FrequencyShifterConfig`, `FrequencyShifterControls`, and
`FREQUENCY_SHIFTER_LATENCY_SAMPLES` (31). This is an editable unworklet 0.4.1
subgraph. It remains **CANDIDATE**, with no listening approval or realtime
clearance. It performs additive signed-Hz translation. Musical pitch-ratio
shifting, dual-readhead transitions, time stretching and ideal arbitrary-band
single-sideband processing remain separate work.

## Entry contract

Instantiate with `{ sampleRate }`, an integer in [8000, 192000], using an explicit
instance name. Call `tick(input, controls)` exactly once per sample inside the
caller's native stride-1 `forSample`. Compose two instances for stereo; no hidden
channel routing or shared phase state exists.

- Input: finite normalized mono audio in [-1, 1]. It is not clipped internally.
- `shiftHz`: finite f32 audio/control node, clamped to [-sampleRate/4,
  sampleRate/4]. Positive shifts raise each positive input frequency; negative
  shifts lower it while it remains above DC. Units are Hz, never semitones.
- `mix`: finite f32 node, clamped to [0, 1], linear blend of delayed real input
  and shifted output. Dry and wet have matched 31-sample group delay.
- `bypass`: bool node selecting the **31-sample-delayed dry** path. Input history
  and modulation phase keep advancing, so returning wet uses current history.
- `reset`: bool node with level semantics. Every high sample silences the output,
  discards its input, invalidates all prior history and holds modulation phase
  zero. The first subsequent low sample is accepted and uses phase zero.

Output is a mono f32 node. Runtime control edits are immediate and unsmoothed.
Changing mix or bypass can click. Signed shift changes preserve phase, but rapid
modulation creates additional sidebands. Apply external smoothing/filtering as
appropriate; there is no hidden parameter framework.

## Filter, phase, latency and headroom

The imaginary path is a fixed 63-tap, odd-antisymmetric, Blackman-windowed
discrete-time Hilbert FIR. The real path is delayed 31 samples. The two zero
endpoints and antisymmetry permit 15 paired multiply-adds with 30 history reads.
The independent reference derives its full kernel from the inverse DTFT of
`-i sign(omega)` and evaluates absolute-time convolution, without importing DSP
coefficients or reproducing its circular buffer.

At output sample n, the shifted signal is
`delayedReal[n] * cos(phase[n]) - hilbert[n] * sin(phase[n])`.
The phase advances by `2*pi*shiftHz/sampleRate` **after** output. Modulation phase
is relative to output time; an input cosine at frequency f has delayed real-path
phase `-2*pi*f*31/sampleRate`. This convention is checked with a complex DFT,
including both signs of shift.

31 samples is group delay: 0.703 ms at 44.1 kHz, 0.646 ms at 48 kHz and 0.323 ms
at 96 kHz. It is not a guarantee that the first 31 wet samples are zero. The FIR
has pre/post ringing around its center and a startup transient. Dry and bypass
are exact 31-sample delays, with zero unavailable history.

Zero shift holds the existing modulation phase. A fresh/reset instance with zero
shift is delayed dry identity. Returning to zero after prior shifting generally
leaves a fixed real/Hilbert phase rotation; it does not force identity.

There is no limiter. The FIR's absolute coefficient sum is approximately
2.345624. A conservative peak bound is 3.346 for normalized input and the
documented mix range, including tiny numerical allowance. Tests include an input
whose output exceeds 2.34, so unity headroom must not be assumed.

History and centered phase use exact power-of-two f64 scaling to avoid the
upstream 0.4.1 state-write threshold erasing tiny finite f32 input and tiny signed
phase increments near zero. This does not remove normal floating-point limits:
an increment below the accumulator's current f64 spacing can still be lost.
Native snapshots retain history, phase, cursor and history validity. The running
quadrature sum is transient and recomputed on every sample. Restore is tested
bit-identically only for the same graph/schema and sample rate.

## Useful band and alias limitations

The numerical acceptance band is input positive frequencies from 0.05 to 0.45
times sample rate, with desired and image measurement frequencies kept distinct
and away from DC/Nyquist. At 48 kHz this is 2.4–21.6 kHz; this short FIR is not a
broadband low-frequency voice pitch shifter.

Independent coefficient DTFT checks sample 4,001 frequencies in that band. The
complex shifted-sinusoid tests measure five interior/near-edge carriers, in both
shift directions, at offline 44.1/48/96 kHz. Their acceptance thresholds are:

- Centered Hilbert real leakage below 1e-13 and imaginary gain error below 0.00035
  on the coefficient grid
- Desired/image rejection above 70 dB in the rendered probes
- Desired complex amplitude error below 3e-5 for each 0.15-amplitude carrier

These are bounded measurements, not a proof over every real frequency or an
arbitrary rapidly changing signal. DC and Nyquist have no usable Hilbert
quadrature. Near either edge, image rejection degrades; a near-DC rendered
counterexample intentionally asserts a substantial unwanted sideband.

There is **no input bandpass or output anti-alias filter**. The caller must keep
every desired `f + shiftHz` strictly between 0 and sampleRate/2 and leave room for
modulation sidebands. A translation through DC reflects with conjugated phase;
a translation through Nyquist aliases back into the band. The signed shift clamp
does not enforce either guard for unknown input content. Tests deliberately
demonstrate the Nyquist folding case. This module cannot preserve harmonic ratios
as a pitch shifter would.

Background on finite-duration Hilbert transitions:
[Julius O. Smith, Hilbert Transform Design Example](https://www.dsprelated.com/freebooks/sasp/Hilbert_Transform_Design_Example.html).
The implementation and acceptance numbers above are specific to this module's
own Blackman kernel and tests.

## Evidence and resource boundary

`tests/frequency-shifter.spec.ts` checks construction, direct impulse/convolution,
signed complex sidebands, immediate automation and clamps, zero-Hz retained
phase, delayed bypass, held/off-boundary resets, full normalized f32 amplitudes,
tiny signed controls, output headroom, aliases, and native snapshot continuation
at three offline rates. Expectations are independently calculated candidates,
never replacement golden audio.

`tests/frequency-shifter-packed.test.mjs` installs the actual tarball in an
isolated locked consumer, strict-checks the public entry, repeats three-rate
convolution/complex-sideband/state tests and builds its Vite worklet. It retains
the tarball, consumer lock, JSON measurements and source hashes under the
candidate evidence manifest. Worklet compilation is not browser execution.

Storage is construction-fixed: 63 f64 history cells (504 bytes), three persistent
scalar state fields (cursor, validity and scaled phase), plus one transient f64
accumulator. The generated processor adds normal unworklet input/output/runtime
storage. No runtime allocation, FFT, asset loading, dependency change, oversampled
path or background scheduler is introduced.

The fresh isolated consumer measures compilation, actual generated WASM size,
memory, cold/startup 128-frame cost and 256 warm blocks including five input and
one output copies. Memory growth and nonfinite scrub counts are asserted zero.
Reported p50/p99/max and deadline exceedances are local Node diagnostics, not a
portable deadline or browser realtime guarantee. Browser execution, independent
review and exact-head integration CI remain distinct acceptance gates.
