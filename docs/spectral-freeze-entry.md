# Bin-centered spectral freeze candidate

Source scope: catalog group 11, [Pitch / time / STFT / spectral engine](https://app.notion.com/p/3ef449b4e81d817db1acf1fff48779b3).
This separate native STFT effect is not the FDN reverb freeze. It uses the reviewed
STFT/FFT sources unchanged, with a bounded construction-time spectrum hook.
CANDIDATE only: no human sound approval, browser/realtime clearance, transparent
sustain, phase-vocoder or phase-locking claim.

## Public contract

`spectralFreeze({ size, hopSize }).tick(input, freeze, reset, everyNSamples)`

- Instantiate once with an explicit subgraph name. Call exactly once per sample
  inside stride-1 `forSample`, supplying its existing `everyNSamples`.
- Construction-fixed power-of-two N=8..1024; H=N/2 or N/4. Input is finite,
  normalized f32 in [-1,1]. `freeze` and `reset` are boolean graph nodes, not
  thresholded or smoothed floating-point parameters.
- A committed frame at t=mH consumes [t-N,t). Freeze is sampled at t. The first
  high sampled frame captures its complex spectrum; the current input sample
  is excluded. Missing startup/reset history is zero padded. Capturing at t=0
  therefore holds silence until release/reset and a later capture.
- Subsequent high frames hold the captured magnitudes and advance each bin's
  phase by +2*pi*k*H/N per frame. No actual-frequency estimator, phase locking,
  neighboring-bin rule, formant preservation or transient detector exists.
- Only nonnegative bins are stored. DC and Nyquist imaginary values are zero;
  negative-frequency bins are reconstructed as complex conjugates. Since legal
  H is even, Nyquist advances by an integer number of full turns and stays real.
- H=N/2 or N/4 makes the phase advance an exact +/-1 or +/-i rotation. An integer
  modulo-(N/H) counter rotates the original captured values, avoiding cumulative
  rotation drift. All captured values retain the reviewed internal 2^128 scale
  so the existing 1e-30 buffer-write flush does not discard f32 subnormal audio.
- Low freeze releases on that committed frame. Live input and analysis history
  continue during hold, so release uses the latest live frame. An unsampled low
  pulse cannot rearm capture. A low committed frame followed by a high committed
  frame releases and recaptures. Between-frame freeze edits have no effect.
- Keeping freeze=false from initialization, or after a reset that discards prior
  frozen overlap, uses the original unmodified spectrum and preserves identity
  PCM exactly. On release, already scheduled frozen overlap may remain and
  settles within N samples of the committed release frame; identity PCM is
  restored after that overlap settles. New freeze state makes its schema distinct; interchange
  with identity-module snapshots is not supported.

## Phase meaning and transitions

For captured analysis frame a[n]=input[t0-N+n]*sin(pi*n/N), a positive phase
increment means the inverse transform on held frame t is exactly the circular
left shift a[(n+t-t0) mod N], in ideal arithmetic. This equivalence is used as a
separate, linear-cost numerical oracle, alongside dense complex DFT/IFFT tests.
It also describes an important limitation: the captured analysis window is part
of the held texture. Steady held output is N-periodic and can have pronounced
window-related amplitude modulation, even for an on-bin sinusoid. Off-bin input
is altered into a periodic texture. This is a deterministic bin-centered freeze,
not a claim to preserve a tone's instantaneous frequency or smooth envelope.

Both windows remain the periodic sqrt-Hann sin(pi*n/N), with WOLA gain 2H/N.
There is no extra transition ramp, fade parameter, dry path, limiter or level
normalization. Capture and release replace newly committed frames; already
scheduled overlap remains. The transition settles within N samples of the
committed edge, and the edge itself is delayed by less than H samples from a
persistent control request. Smear, ringing, periodic beating and altered peaks
are expected. WOLA overlap alone is not an artifact-free-transition guarantee.

The live reference alignment is N samples. Processed onset is frame-dependent;
N is not a universal first-nonzero delay for held content. There is no finite
zero-input drain while held. After freeze is kept low and the source ends,
provide at least 2N zero samples from the later of source end and release request.
This conservatively includes the next sampled release and outstanding overlap.

## Reset, snapshots and execution

Reset silences output immediately and discards that input sample. It invalidates
the hold and clears its integer phase immediately, without rephasing the absolute
frame clock. High freeze can capture again at the next non-reset committed frame.
Held reset prevents capture. Captured buffer bytes are logically invalidated,
not physically scrubbed; a later capture overwrites every stored bin before use.
The framing's existing pending reset discards prior history and overlap.

Persistent state contains the existing history/overlap/cursor/reset state, two
(N/2+1)-element f64 capture planes, the hold flag, held phase and a private
modulo-H sample clock. The latter mirrors the reviewed framing cursor%H; neither
clock changes phase on reset. Frame controls and capture decisions are transient.
Full snapshots continue exactly for the identical graph, configuration and rate.
Tests cover inactive, frozen, post-reset and release/rearm states at every
128-sample snapshot offset class. No cross-rate or cross-configuration migration
promise is added.

The shared STFT dispatch remains every min(H,128) samples. For H>128, the FFT,
hook and IFFT still execute eagerly every128 samples; only true t=mH frames
capture, advance the held phase or commit overlap. These extra hook calls do not
change persistent capture/hold phase. No CPU saving is implied by a select.

## Headroom derivation

In ideal real arithmetic, every input analysis frame has Euclidean norm at most
sqrt(N), because |input[n]|<=1 and |window[n]|<=1. A complex DFT followed by its
properly scaled inverse preserves this norm; multiplying each bin by a unit
phase factor preserves it too. Every live or held inverse-frame sample is thus
bounded by sqrt(N). At an output sample, at most N/H synthesis frames overlap,
each with |window|<=1 and scale 2H/N. The triangle inequality gives
(N/H)*(2H/N)*sqrt(N)=2*sqrt(N), at most64 for N1024. The same argument covers
capture/release overlap between different frames. A tighter bound is possible
using the actual window energy; this deliberately conservative bound suffices.

This is a mathematical headroom bound for normalized inputs, not a numerical
roundoff theorem. Finite-f64 FFT error and final f32 rounding are separately
measured against independent oracles; no limiter enforces the bound. Unexpected
nonfinite or out-of-range audio input is outside the contract.

## Validation requirements

Independent dense DFT/positive-phase rotation/IFFT/time-indexed WOLA, plus the
separate circular-left-shift oracle; DC/Nyquist, coherent/off-bin tones, capture
exclusion of current input, frame-edge controls, both legal hops, all small and
large reset offsets, held reset, snapshot phases, subnormals, normalized extrema,
held sustain and release drain at44.1/48/96kHz. Existing no-hook graph/schema/PCM/
snapshot compatibility remains unchanged. An isolated installed public-package
consumer must typecheck, render, restore, report memory/cold/warm costs and build
its Vite worklet before package acceptance. Audio evidence is CANDIDATE, with
source/package/audio hashes and no per-channel normalization.

## Initial focused evidence

The first typecheck and25-test run passed:19 freeze tests,3 exhaustive large-reset
cases and3 unchanged no-hook identity compatibility cases across44.1/48/96kHz.
It completed in45.4seconds with718MB observed process-group RSS under a180second/
2GiB guard. The native DSP, dense-DFT WOLA and circular-shift WOLA agree within
2e-7 absolute normalized amplitude; tiny-input assertions scale the tolerance down
to one f32 subnormal ULP. Live identity PCM and full-snapshot continuation are
bit exact. The reviewed shared FFT/STFT files were not modified. This focused
pass does not substitute for independent review or public-package validation.
