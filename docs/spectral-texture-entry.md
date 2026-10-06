# Bounded spectral texture entry contract

Source scope: catalog group 11, [STFT blur and cross-synthesis](https://app.notion.com/p/3ef449b4e81d817db1acf1fff48779b3).
This proposal adds two CANDIDATE native subgraphs. It does not claim spectral
resynthesis completeness, transparent speech, phase-vocoder quality, phase
locking, human sound approval, or real-time clearance.

## Shared framing

- Construction-fixed power-of-two N=8..256, H=N/2 or N/4. Rebuild to change.
- Instantiate with an explicit subgraph name and call exactly once per sample
  inside stride-1 `forSample`, passing its native `everyNSamples`.
- Every audio input is finite normalized f32 in [-1,1]. The two cross-synthesis
  inputs must belong to the same sample timeline and call.
- Reuse the existing FFT/STFT code unchanged: periodic sqrt-Hann analysis and
  synthesis, forward unnormalized DFT, inverse 1/N, WOLA scale 2H/N, internal
  2^128 scaling, and live reference delay N.
- A committed frame at t=mH consumes [t-N,t), excludes current input, and samples
  controls at t. Missing startup/reset history is zero padded. H<=128 divides
  the native 128-sample block; there are no eager noncommitting frame calls.
  The existing N1024 single-input clearance is not inherited: two full framers
  add cost and scheduling/state proof obligations. N<=256 bounds that initial
  composition and avoids H>128's eager noncommitting hooks entirely.
- Clamp amount to [0,1]; NaN becomes 0, infinities clamp. Interpolation is linear
  in bin magnitude, not dB, power, audio time, or equal-power gain. It replaces
  newly committed frames; previous overlap remains until it finishes within N.
- DC and Nyquist are real; negative bins are reconstructed as conjugates.
- There is no output normalizer, limiter, extra transition ramp, or dry path.
  Processed onset can precede the N-sample identity alignment. Drain 2N zeros
  after the last nonzero input (both inputs for cross-synthesis).

## Frequency-magnitude blur

`spectralBlur({ size, hopSize, radius }).tick(input, amount, reset, everyNSamples)`

Radius is a fixed integer 1..min(8,N/2-1). Let X[k] be the full two-sided complex
DFT and A[k]=|X[k]|. Define a circular triangular blur on the raw, two-sided DFT
magnitudes, not on single-sided coherent-amplitude estimates:

    B[k] = sum(j=-R..R) (R+1-|j|)/(R+1)^2 * A[(k+j) mod N]
    T[k] = (1-amount)*A[k] + amount*B[k]

The normalized symmetric kernel crosses DC and Nyquist through the corresponding
conjugate bins. No endpoint duplication or renormalized truncated kernel occurs.
Let P=max_j A[j]. Retain the current input phase only when A[k]>0 and
A[k]>=2^-20*P: Y[k]=T[k]*X[k]/A[k]. Otherwise use phase zero,
Y[k]=T[k]+i*0. At DC/Nyquist a retained real bin preserves its sign; a bin below
the floor or exactly zero gets positive real magnitude. Equality belongs to
the retained-phase side only when A[k]>0.

Implement phase as separately normalized real/imaginary components, then
multiply by T, rather than multiplying X by an unbounded T/A gain. The divisor
is replaced by 1 when A=0 before evaluating either select branch. All finite
inputs remain finite. The floor is relative to the same frame's maximum raw
magnitude, so uniformly scaling a frame preserves the phase decision in ideal
arithmetic, including tiny inputs. This deliberately discards weak-bin phase
and can abruptly change phase at the floor. It is a deterministic texture
choice, not extra precision, smoothing or a phase-locking guarantee.
For target magnitude T and retained phase phi, replacing zero phase changes
that complex bin by 2*T*abs(sin(phi/2)), up to 2T, even when the original A is
tiny. The below/at/above floor cases and this jump bound are required evidence;
the threshold must not be changed to make an oracle comparison pass.

The rejected exact-nonzero phase rule could promote FFT roundoff at a spectral
null into audible redistributed magnitude and make two valid DFT algorithms
disagree audibly. Keep that counterexample in validation. The floor stabilizes
nulls, but decisions extremely close to the floor remain finite-precision
sensitive, and full-frame rescaling may quantize f32 input differently.

The fixed amount=0 path selects the original unmodified spectrum; its PCM
identity claim must be tested, including subnormal inputs and arbitrary reset.
Once amount is changed to 0, previous processed overlap first needs to settle.
At amount=1 the full triangular blur is used, which can add energy to previously
empty bins using the deterministic phase rule above. This is frequency blur,
not a time-memory blur or a freeze.

## Gain-bounded cross-synthesis

`spectralCrossSynthesis({ size, hopSize, maxGain }).tick(carrier, modulator, amount, reset, everyNSamples)`

maxGain is a finite construction-fixed number in [1,16]. Let C[k], M[k] be the
synchronized carrier/modulator frames, A[k]=|C[k]|, and B[k]=|M[k]|:

    target[k] = min(B[k], maxGain*A[k])
    T[k] = (1-amount)*A[k] + amount*target[k]
    Y[k] = C[k]*((1-amount) + amount*min(B[k]/A[k],maxGain))

For exactly zero A, set the ratio to zero, with a safe denominator before select
evaluation. Zero carrier therefore remains silent, including when the modulator
is nonzero. A near-zero carrier is amplified by at most maxGain, not promoted to
the modulator level. The amount=0 path selects the original unmodified carrier
spectrum. A silent modulator with amount=1 suppresses the carrier spectrum.
Same-input amount=1 should numerically preserve the carrier; any stronger
bit-identity claim depends on measured proof and is not presumed.

Carrier phase is unchanged; modulator phase does not contribute. Both spectra
use identical raw DFT/window calibration, so the single-sided coherent-window
factor (1/windowSum at DC/Nyquist and 2/windowSum elsewhere) cancels in every
same-bin ratio. Full cross-synthesis replaces raw carrier magnitudes with
modulator magnitudes only where the gain cap permits. It does not transfer a
smooth vocal envelope, move formants, estimate frequencies, or guarantee speech
intelligibility. No audio-rate modulator bypass/identity is inferred from a zero
gain or silent control input.

## Composition, reset and native state

The cross-synthesis implementation will first tick a separately named private
modulator STFT instance whose construction hook materializes current magnitudes
into its own transient buffer, then tick the carrier STFT instance whose hook
reads those magnitudes. Both use the same N, H, reset and outer sample callback.
The modulator's inverse transform/output is unused; it still executes. This
deliberate bounded overhead avoids modifying shared framing or adding a second
framing engine. Native source inspection shows separate everyNSamples counters
and sequential statement emission; synchronized analysis and no one-frame lag
remain requirements for independent sample-by-sample proof.
The materializing hook writes and native frame statements must remain present
even though the tap's audio return is unused; inspect the captured graph and
prove observed modulator changes reach the matching carrier frame.

Reset immediately silences and discards the current input(s), invalidates old
history/overlap, and does not rephase either frame cursor. Held reset remains
silent. State contains the reviewed native history/overlap/cursor/reset state
per instance. Magnitudes, FFT buffers, windows and sampled controls are transient
and are fully recomputed before use at the next frame. No cross-frame blur
memory or private snapshot format is introduced.

Only full native same-graph/configuration/sample-rate snapshots are supported.
Restoring only one member of a cross-synthesis pair is outside the contract.
Tests must prove exact continuation across every legal H class at native
128-sample boundaries, including active processing, pending reset, and held
reset. No cross-configuration/schema/rate migration is promised.

## Ideal headroom and validation

For normalized inputs, an analysis frame has L2 norm <=sqrt(N). The normalized
circular nonnegative blur kernel is an L2 contraction on magnitudes, and linear
interpolation preserves that bound. Cross-synthesis's target magnitude is
componentwise <=|M|; triangle inequality bounds the interpolated norm by the
larger of the normalized carrier/modulator frame norms. Phase replacement does
not change norm. Each inverse-frame sample is thus bounded by sqrt(N), and at
most N/H frames each scaled by 2H/N overlap, giving |output|<=2*sqrt(N), at most
32 for N256. This is conservative ideal arithmetic, not a finite-f64 theorem or
an enforced ceiling. No per-channel output normalization is permitted in proof.

Required evidence: independent dense DFT/magnitude operation/IFFT/absolute-time
WOLA; analytic circular-kernel DC/Nyquist/isolated-bin expectations; amount
endpoints/interior/nonfinite controls; modulator scaling/phase independence and
explicit carrier zero/near-zero gain-cap behavior; current-sample exclusion and
simultaneous transient frames; every small reset offset, held reset, snapshots,
subnormals/extrema, finite drain and same-schema state at 44.1/48/96 kHz. Keep
blur's full-frame scale invariance, exact-zero/weak/retained phase boundary,
DC/Nyquist sign and rejected near-null amplification counterexamples explicit.
Keep existing no-hook framing/schema/PCM tests unchanged. Independently review this
contract before DSP, and review actual implementation before integration.

Measure maximum N256/R8 graph memory/cold/warm render costs later under the
coordinator's fixed guard and exclusive resource lease. Public package exports,
installed-consumer and hosted browser acceptance belong to the coordinator.
No install, runtime/loader/snapshot/framework/upstream changes are proposed.

## Initial focused evidence

The initial 21-test focused/native compatibility pass and package typecheck
completed in 20.25 seconds with 580 MB summed process-group RSS under the fixed
120-second/2 GiB guard. The untouched source implementation passed independent
DFT/WOLA, exact amount-zero identity, synchronized dual frames, tiny inputs,
gain caps, reset, N256 native continuation and original no-hook compatibility.
Independent review requested small-hop snapshot classes and explicit measured
phase-floor ratios. The expanded 24-test pass and typecheck completed in 23.03
seconds with 576 MB summed process-group RSS under the same guard. It covers
every supported H class, pending/held reset snapshots, measured actual f32
floor ratios, the non-real phase jump, and exact power-of-two scale invariance
where f32 can represent the scaled waveform without subnormal quantization.
This evidence is not public-package, hosted-browser or human-sound approval.
