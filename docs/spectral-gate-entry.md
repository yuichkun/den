# Framewise spectral gate entry proposal

Status: root-approved bounded entry; implementation validation is separate. Source scope: catalog group
11, [Pitch / time / STFT / spectral engine](https://app.notion.com/p/3ef449b4e81d817db1acf1fff48779b3).
This is one bounded spectral effect built on the independently reviewed
`4be1c9991459ea559102a5fa8fd76fb3d52a94b9` STFT framing.

## API and meaning

- `spectralGate({ size, hopSize }).tick(input, threshold, floor, reset, everyNSamples)`
- Construction-fixed power-of-two N=8..1024 and H=N/2 or N/4.
- Input: finite normalized f32 audio in [-1,1]. Controls: f32. Threshold is clamped to [0,max-f32], floor to [0,1];
  infinities saturate, NaN threshold becomes 0 and NaN floor becomes 1 (all-pass).
- A committed frame at sample t=mH consumes [t-N,t). It samples threshold and
  floor at t. The current input sample is not part of that frame. Between-frame
  control values do not retroactively modify already scheduled overlap audio.
- With w[n]=sin(pi*n/N), W=sum(w), and forward unnormalized DFT X, the gate level
  is |X[k]|/W for DC/Nyquist and 2|X[k]|/W for other nonnegative bins. These are
  linear, coherent-window-calibrated single-sided bin amplitude units. They are
  neither RMS, dB, noise power density nor an exact off-bin sinusoid amplitude.
- Computed level >= threshold gives gain 1; otherwise gain=floor. One decision
  applies to the conjugate pair. DC/Nyquist imaginary components are zero.
  Floating roundoff can determine either result exactly at a threshold boundary.
- No attack/release, hysteresis, adaptive noise profile, gain interpolation,
  makeup normalization, limiter, dry path or bypass scheduler. Threshold 0 or
  floor 1 is the all-pass limit. Low bins may contain positive/negative-frequency
  window-lobe interference; threshold units remain the stated bin formula.

## Framing, state and headroom

Retain the original periodic sqrt-Hann analysis/synthesis windows, normalization
2H/N, reset discard semantics, persistent cursor, and every min(H,128) dispatch.
For H>128 an FFT/IFFT pair still executes every128 samples; only cursor%H==0
commits frames. No H-rate CPU-saving claim.

The WOLA alignment/reference delay is N samples; a processed transient can spread
across its synthesis frame [t,t+N), so its first nonzero sample need not occur at
input onset+N. The all-pass limit retains exact N-sample delay. Drain at least 2N
zero input samples after the source ends. Spectral processing can spread the last
input through the rest of its analysis frame and then through a synthesis frame;
the identity-only N-sample drain is insufficient for the gate. Reset silences immediately, discards that input sample, clears
old history/overlap and leaves absolute frame phase unchanged.

Only the existing history, overlap, cursor, valid history and pending reset need
persistent storage. Frame controls and spectrum work are transient and overwritten
before use. Identical graph/rate full-snapshot continuation remains in scope.

Attenuating bins can increase individual time-domain peaks. For normalized input,
an ideal contraction bound per frame and the overlapping windows give the
conservative output bound 2*sqrt(N), at most64 for N1024. This is headroom guidance,
not a limiter or loudness promise; measured peaks accompany candidate evidence.

## Implementation boundary and verification

Add a narrow optional internal construction-time spectrum-copy hook to the
existing STFT function. The identity branch must produce the same graph, schema,
PCM and full snapshots as its frozen predecessor. Do not modify the FFT kernel,
existing convolution or unworklet. The public gate wrapper is separate; shared
exports, CI and site belong to integration.

Required tests: independent direct DFT/bin-mask/inverse-DFT/time-indexed WOLA;
DC, Nyquist, on/off-bin tones, mixed strong/weak bins, threshold units and equality
limits, conjugate symmetry, frame-sampled controls around hop/block boundaries,
all reset phases, held reset, tiny f32 signals, finite normalized extrema and
headroom, all quantum-offset snapshot phases, and 44.1/48/96kHz renders. A clean
installed public package must typecheck, render, restore and build a Vite worklet.
Document fresh compile/cold/warm costs, fixed memory and zero scrub observations.

Expected artifacts include musical noise from hard decisions, ringing, transient
smear, pumping under threshold edits and changed peaks. Neither identity proof nor
numerical correctness means artifact-free sound. CANDIDATE only: no human sound,
browser realtime, pitch shifting, phase vocoder, long-IR or den-kit claim.


## Internal numeric details

History and FFT spectra retain the existing exact factor 2^128. The gate compares
`factor*(Re(Xscaled)^2+Im(Xscaled)^2)` against `(threshold*W*2^128)^2`, where factor
is 1 for DC/Nyquist and 4 for the other bins. Double precision safely contains
both sides over the full finite f32 control range. The comparison needs no
runtime square root or dB conversion. Floor gains are stored multiplied by
2^128 so even the smallest positive f32 floor is not silently flushed by the
existing buffer-write policy. One gain is calculated and stored for each
nonnegative bin; the negative bin is reconstructed from that canonical member.

Threshold 0 and floor 1 explicitly choose the original unmodified spectrum.
This preserves identity PCM exactly, rather than relying on re-mirrored FFT
roundoff to round identically. No FFT work is skipped by these eager selects.
The internal hook exists only during graph construction and is not an additional
public `stftIdentity.tick` argument or an arbitrary runtime callback.

## Focused validation

The first bounded implementation run passed all49 tests in the seven spectral,
convolution, gate and hook-compatibility files at44.1/48/96kHz. It completed in
72.9seconds with549MB observed process-group RSS under a120second/2GiB guard.
Existing FFT/STFT/convolution tests and numerical tolerances were unchanged.

The no-hook construction produced byte-identical WASM and schema, exact PCM and
full snapshots against the frozen4be1c99 STFT at N8/64/256/512/1024 and both large
hop classes. Bidirectional restoration was also exact. Gate tests separately
cover every large reset phase, every quantum-offset snapshot phase, held reset,
frame-sampled edits, DC/Nyquist and off-bin cases, NaN/infinite controls,
subnormal audio and controls, and actual transient spread/peak overshoot.

The isolated packed consumer records its exact source/package/audio hashes,
three-rate DFT/WOLA errors, restore equality, fixed memory and fresh/warm local
Node costs. It also emits a CANDIDATE48kHz three-channel WAV: original source,
N-aligned reference, and gate output, with no per-channel normalization. This is
an audition artifact, not a human-approved golden. Its Vite build is compilation
evidence, not browser audio or realtime clearance.

A follow-on21-test gate run extends active tiny-control, normalized-extreme
headroom and strong/weak partial separation checks to all three rates. It passed
in16.4seconds with506MB observed process-group RSS. The DSP did not change between
these runs; the unchanged seven-file suite plus these additions contains56 tests.


## Processed-tail correction

Independent review retained a concrete counterexample to the earlier N-zero
drain statement: N64/H16, an impulse at sample127, threshold0.035 and floor0.
An N-zero drain ends before sample192, but processed output continues through
sample223, with a post-cutoff peak around0.02336. This is expected spectral
spreading, not a framing-state defect. The conservative public drain requirement
is now2N zero-input samples. A regression checks that the N cutoff loses nonzero
output and that output is exactly zero after the2N cutoff at all three rates.
The corrected audition preserves its original source samples and appends another
N zeros, providing a complete2N drain. Prior truncated audition artifacts must
not be used as the completed effect candidate.
