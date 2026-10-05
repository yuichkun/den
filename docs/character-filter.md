# Bounded nonlinear character low-pass

Status: CANDIDATE. This is the representative nonlinear filter in
[catalog group 6](https://app.notion.com/p/3ef449b4e81d817db1acf1fff48779b3).
It is a four-stage saturating feedback low-pass with a deliberately discrete
topology. It does not claim to reproduce a particular analog circuit.
The existing clean filter, SVF, EQ, instrument and sounds are unchanged.

## Entry and musical controls

`characterFilter({ sampleRate })` from `@denaudio/den/character-filter` is an
ordinary unworklet `defineSubgraph`. Its immutable rate is finite, 8000–192000 Hz.
Call `tick(input, poleHz, resonance, drive, reset)` exactly once per sample.
The input and three controls are `Node<f32>`; reset is `Node<bool>`; the result
is a mono `Node<f32>`. Instantiate separately per channel or voice.

- Input explicitly clamps to [-8, 8] before drive. NaN becomes zero; infinities
  clamp to their signed endpoint. This is an exposed input bound, not an
  undocumented output safety clipper.
- `poleHz` clamps to [20, min(20000, sampleRate/5)] Hz; NaN becomes 20 Hz.
  It sets the matched-z individual-pole tuning. Four poles together have a
  lower small-signal -3 dB corner, approximately 0.435 × poleHz when poleHz is
  well below the sample rate and resonance is zero. It is not an overall
  measured -3 dB cutoff. Large input and resonance further change the response.
- `resonance` clamps to [0, 1]; NaN becomes zero. It maps linearly to global
  negative feedback k = 4 × resonance. It is not Q. Increased feedback lowers
  low-frequency gain and changes ringing; there is no automatic bass or level
  compensation and no promised self-oscillation mode.
- `drive` is a linear pre-feedback input gain [0, 16]; NaN becomes one.
  Zero removes new excitation but does not immediately mute existing history.
  Drive and resonance interact inside the loop.
- Reset clears all four histories before processing the current input. A held
  reset processes each sample from zero history. Reset may click. No smoothing,
  bypass, wet/dry path, output makeup gain, lookahead or sample buffer is hidden.

Infinities on controls clamp to the corresponding endpoint. All three controls
are consumed every sample, including abrupt changes. The bound below includes
such changes; it does not establish click-free or alias-free modulation.

## Exact topology and state bound

Let S(v) = v / sqrt(1 + v²), a = 1 - exp(-2π poleHz / sampleRate), b = 1-a.
The current sample proceeds in this order, with all old histories captured first:

1. u = boundedInput × drive - k × oldStage4
2. stage1 = b × oldStage1 + a × S(u)
3. stage2 = b × oldStage2 + a × S(stage1)
4. stage3 = b × oldStage3 + a × S(stage2)
5. stage4 = b × oldStage4 + a × S(stage3); output = stage4

There is one sample of global feedback delay. The feed-forward cascade uses
current-sample stage outputs. This is neither a zero-delay nonlinear solver nor
a clean linear filter followed by distortion. Every stage's nonlinear transfer
changes the future feedback and history. No iterative convergence is required.

For the supported control/rate bounds, 0 < a < 1. Each state update is a convex
combination. Starting from zero or a snapshot produced by this same processor,
|stage1| ≤ 1, |stage2| ≤ 1/sqrt(2), |stage3| ≤ 1/sqrt(3), |stage4| ≤ 1/2:
S maps each preceding bound into the next one. This argument does not depend
on feedback, drive or tuning remaining constant. First-stage input magnitude
is at most 8×16 + 4×1/2 = 130. All arithmetic stays finite, and every state
and the output remain bounded under arbitrary legal control trajectories.
The output headroom bound is therefore 0.5 (-6.0206 dBFS), apart from rounding.
This is intentional cascaded saturation, not a transparent limiter claim.
It does not bound clicks, distortion, modulation spectra or perceptual loudness.

The small-signal, fixed-control transfer is
H(z) = drive × P(z)^4 / (1 + k z^-1 P(z)^4), P(z) = a/(1 - b z^-1).
At DC it approaches drive/(1+k). At Nyquist, P(-1) = a/(2-a), so
H(-1) = drive × P(-1)^4/(1 - k P(-1)^4). The delay's sign matters.
Nonlinear steady DC is separately determined by y = S(S(S(S(input×drive-k×y)))).

## Numeric choices and cost

All internal arithmetic is f64. The coefficient uses the degree-18 Taylor
polynomial for 1-exp(-x), x in [2π20/192000, 2π/5]. Its alternating-series
remainder is bounded by (2π/5)^19/19! < 6.4e-16. It does not call the runtime's
lower-precision exponential, and has no unrestricted-domain approximation.
The four audio histories use exact binary scaling 2^128 when stored. This keeps
tiny f32 histories above unworklet 0.4.1's scalar-state flush at
|stored value| < 1e-30. The corresponding unscaled history threshold is about
2.94e-69, far below the smallest f32 sample. Still smaller histories may flush;
there is no promise to preserve infinite mathematical tails. Arbitrary
hand-edited snapshots are not supported.

The graph has exactly four f64 state slots, four square roots and a fixed
coefficient polynomial per sample. Stage writes/readbacks materialize the
cascade; there is no runtime allocation, variable loop, parallel runtime,
oversampling, ADAA wrapper or additional framework. The first slot temporarily
holds the bounded coefficient inside tick and is overwritten with its normal
history before returning. A snapshot taken between blocks contains histories.
Same-processor/schema/rate native snapshots resume exactly.

## Evidence and limits

The focused tests and isolated installed-package consumer compare against a
scalar reference using Math.exp and Math.hypot, an independently derived
small-signal direct-form recurrence, and a bisection solution of the static DC
equation. They check 44.1/48/96 kHz, rate construction endpoints, signed input
and control bounds, nonfinite repair, high-drive headroom, control steps/sweeps,
DC and Nyquist, harmonics/folded residual, reset and held reset, distinct
instances, tiny/subnormal histories and noninitial snapshot continuation.
Negative controls reject bypass, omitted restore and a post-shaped linear
filter. Full evidence records include settings, source/input/output hashes,
raw unnormalized f32/WAV, fixed-scale waveforms and dependency/package identity.

The first local candidate passed all 20 focused tests plus the isolated
installed-package type, render, snapshot and actual worklet-build checks.
The three-rate recurrence maximum error was below 1.491e-8. The 16,384-frame
musical-control fixture peaked below 0.499602, with no scrubbed samples and exact
repeated PCM and noninitial snapshot continuation. A one-instance, five-input
offline graph compiled to 3,293 WASM bytes and a 226-byte snapshot containing
four scalar slots; the two-instance focused graph was 6,278 WASM bytes. These
are graph-specific artifact measurements, not callback timing guarantees.

The deliberately harsh 2-peak sine at normalized bin 997/4096, poleHz=fs/5,
resonance=0.7 and drive=16 measured folded residual 0.068893 RMS
(-23.24 dBFS). Frequency and pole tuning both scale with sample rate in this
case, so the 44.1/48/96 kHz result is the same normalized discrete system.
This audible-risk measurement is retained as a limitation; it is not suppressed
by normalizing the output or by calling the model antialiased.

The actual 48 kHz browser gate is implemented separately. It checks independent
steady-DC equations after drive/resonance changes, a pole-tuning change on a
997 Hz tone, and restoration of nonzero history after a verified reset to zero.
It has not been run locally. Hosted exact-head CI and independent review are
still required. A compiled worklet does not count as browser execution.

This is a base-rate nonlinear processor. Harmonics can alias. A downstream
low-pass cannot undo already folded energy; low output amplitude is not proof
of low aliasing. The coherent-tone residual measurement records this limitation
without claiming an anti-alias improvement or analog authenticity. No human
listening approval, approved golden, all-device real-time clearance, maximum
voice count or universal perceptual quality is established by these tests.

The formulas above define an original discrete model and independent oracle;
no third-party circuit source or preset is bundled. The catalog's
[Cytomic paper collection](https://cytomic.com/technical-papers/) is background
for distinguishing topology and response, not evidence of sonic equivalence.
